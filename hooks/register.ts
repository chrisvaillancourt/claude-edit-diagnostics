import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { parseOutput } from './parse'
import {
  BUSY_NOTE,
  CONFIG_PATH,
  INITIAL,
  MIN_CHECK_MS,
  PENDING_NOTE,
  USAGE,
  assessCheck,
  configFrom,
  configState,
  findingPaths,
  formatReport,
  inactiveNote,
  isActive,
  nextSnapshots,
  noticeKey,
  outputProblem,
  parseArgs,
  parseChecksFile,
  planRun,
  planText,
  relativeToRoot,
  statusText,
  summaryLines,
  withRealPaths,
} from './policy'
import type { CheckOutcome, ConfigState, Plan } from './policy'
import type { ChecksFile, Config, ParseResult, Session } from '../types'

const NAME = 'edit-diagnostics'

// Change the shape tag when Session's fields change: a value an older version
// stored (it outlives a hot reload) then reads as INITIAL instead of breaking.
const sessionAtom = atom({ plugin: 'edit-diagnostics', key: 'session' } as const, INITIAL, { shape: 'session-2' })

// Module variables reset on a hot reload; register and session.start run
// again then. Anything that must persist goes in $.state or $.store.
let config: Config = configFrom({})
/** The session's working directory, resolved: the project root. */
let root: string | null = null
let isInteractive = true
/** Names this module load; a running claim from another load is stale. */
let loadId = newId()

const BATCH_SKIPPED = 'batch-hook-skipped'

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
}

/** Best effort: reporting must never throw out of a hook or a timer. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`${NAME}: ${text}`)
  } catch {
    // nothing to do
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // The engine prefixes a refused `$` call with `<plugin>: $.<noun>.<verb>: `.
  return msg.replace(/^edit-diagnostics: \$\.[\w.]+: /, '').replace(/\s+/g, ' ').slice(0, 200)
}

const approvalKey = (r: string) => `approval:${r}`

async function approvedText($: EngineInterface, r: string): Promise<string | undefined> {
  const v = await $.store.get(approvalKey(r))
  return typeof v === 'object' && v !== null && typeof (v as { text?: unknown }).text === 'string' ? (v as { text: string }).text : undefined
}

/** The config file's text and its state against the approval, read fresh. */
async function loadState($: EngineInterface, r: string): Promise<{ state: ConfigState; text: string | null }> {
  const path = `${r}/${CONFIG_PATH}`
  let text: string | null
  try {
    text = (await $.fs.exists(path)) ? await $.fs.read(path) : null
  } catch (err) {
    return { state: { kind: 'unreadable', error: errText(err) }, text: null }
  }
  return { state: configState(text, await approvedText($, r)), text }
}

/** The edited file as a root-relative path, or null when it isn't a regular file inside the root. */
async function editedPath($: EngineInterface, r: string, path: string): Promise<string | null> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stat.realPath === undefined) return null
  return relativeToRoot(r, stat.realPath)
}

type Ran = { plan: Plan; parsed: ParseResult } | { plan: Plan; skipped: string } | { plan: Plan; stopped: true }

/**
 * Whether run `runId` still owns the session and the mod is on, read fresh:
 * a versioned update that writes the same value back (a plain read can be stale).
 */
async function owns($: EngineInterface, runId: string): Promise<boolean> {
  let ok = false
  await update($, sessionAtom, s => {
    ok = s.running?.runId === runId && isActive(config, s)
    return s
  })
  return ok
}

/** Runs one plan within what's left of the run's budget. Never throws. */
async function execute($: EngineInterface, r: string, plan: Plan, deadline: number, runId: string): Promise<Ran> {
  const remaining = deadline - (await $.clock.now())
  if (remaining < MIN_CHECK_MS) return { plan, skipped: 'time budget used up' }
  const cwd = await $.fs.stat(plan.cwdAbs, { resolve: true }).catch(() => undefined)
  const real = cwd?.realPath
  if (cwd?.kind !== 'dir' || real === undefined || (real !== r && relativeToRoot(r, real) === null)) {
    return { plan, parsed: { ok: false, reason: `cwd ${plan.check.cwd} is missing or leaves the project` } }
  }
  // off, revoke or /clear since the run began: start nothing more.
  if (!(await owns($, runId))) return { plan, stopped: true }
  const timeoutMs = Math.min(config.timeoutMs, remaining)
  const started = await $.clock.now()
  let raw
  try {
    raw = await $.process.run(plan.argv, { cwd: plan.cwdAbs, timeoutMs })
  } catch (err) {
    const elapsed = (await $.clock.now()) - started
    const reason = elapsed >= timeoutMs - 50 ? `timed out after ${timeoutMs} ms` : `could not run: ${errText(err)}`
    return { plan, parsed: { ok: false, reason } }
  }
  const problem = outputProblem(raw)
  if (problem !== null) return { plan, parsed: { ok: false, reason: problem } }
  const parsed = parseOutput(plan.check.parser, raw)
  // Give reported paths the same identity as edited ones (both realPath).
  const realOf = new Map<string, string>()
  for (const abs of findingPaths(parsed, plan.cwdAbs)) {
    const stat = await $.fs.stat(abs, { resolve: true }).catch(() => undefined)
    if (stat?.realPath !== undefined) realOf.set(abs, stat.realPath)
  }
  return { plan, parsed: withRealPaths(parsed, plan.cwdAbs, realOf) }
}

/**
 * Claims the one run, takes every pending path, runs the checks that cover
 * them and, if the claim is still its own afterwards, learns the results and
 * answers the report. `null` when nothing ran or the results were dropped.
 */
async function runPending($: EngineInterface, r: string, file: ChecksFile): Promise<string | null> {
  const runId = newId()
  let paths: string[] = []
  const claimed = await update($, sessionAtom, s => {
    if (s.running !== null && s.running.loadId === loadId) return s
    const stale = s.running?.paths ?? []
    paths = [...new Set([...stale, ...s.pending])]
    return { ...s, pending: [], running: { runId, loadId, paths } }
  })
  if (claimed.running?.runId !== runId) return BUSY_NOTE

  const plans = planRun(file.checks, r, paths)
  const deadline = (await $.clock.now()) + config.batchTimeoutMs
  const ran: Exclude<Ran, { stopped: true }>[] = []
  for (const plan of plans) {
    const x = await execute($, r, plan, deadline, runId)
    if ('stopped' in x) break
    ran.push(x)
  }

  let text: string | null = null
  await update($, sessionAtom, s => {
    text = null
    if (s.running?.runId !== runId) return s
    if (!isActive(config, s)) return { ...s, running: null }
    const outcomes: CheckOutcome[] = ran.map(x => {
      if ('skipped' in x) return { kind: 'skipped', id: x.plan.check.id, parser: x.plan.check.parser, reason: x.skipped }
      const o = assessCheck(x.plan.check, x.parsed, x.plan.files, r, x.plan.cwdAbs, s.snapshots)
      return o.kind === 'ok' && x.plan.notChecked > 0 ? { ...o, notChecked: x.plan.notChecked } : o
    })
    const report = formatReport(outcomes)
    text = report.text === '' ? null : report.text
    return {
      ...s,
      running: null,
      snapshots: nextSnapshots(s.snapshots, outcomes, report.omitted),
      lastRun: outcomes.length === 0 ? s.lastRun : summaryLines(outcomes),
    }
  })
  return text
}

/** What to tell the model after one successful main-loop mutation of `path`, or null. */
async function afterMutation($: EngineInterface, path: string): Promise<string | null> {
  const r = root
  if (r === null) return null
  const session = await read($, sessionAtom)
  if (!isActive(config, session)) return null
  const rel = await editedPath($, r, path)
  if (rel === null) return null
  const { state, text } = await loadState($, r)
  if (state.kind === 'missing') return null
  if (state.kind !== 'approved') {
    const note = inactiveNote(state, isInteractive)
    const key = noticeKey(state, text)
    let isNew = false
    await update($, sessionAtom, s => {
      isNew = !s.notices.includes(key)
      return isNew ? { ...s, notices: [...s.notices, key].slice(-20) } : s
    })
    if (!isNew || note === null) return null
    log($, note.replace(/^edit-diagnostics: /, ''))
    return note
  }
  if (planRun(state.file.checks, r, [rel]).length === 0) return null
  await update($, sessionAtom, s => ({ ...s, mutations: s.mutations + 1, pending: [...s.pending.filter(p => p !== rel), rel] }))
  if (config.delivery === 'batch') return PENDING_NOTE
  return runPending($, r, state.file)
}

/** The path a successful native mutation wrote, or null for any other call. */
function mutatedPath(e: { tool: unknown } & Record<string, unknown>): string | null {
  const tool = String(e.tool)
  if (tool === 'Edit' || tool === 'Write') return typeof e.file_path === 'string' ? e.file_path : null
  if (tool === 'NotebookEdit') return typeof e.notebook_path === 'string' ? e.notebook_path : null
  return null
}

async function approve($: EngineInterface, originKind: string): Promise<string> {
  if (originKind !== 'composer') return 'Not approved: approval must be typed at the prompt by the person running this session.'
  if (root === null) return 'Not approved: the project root is not known yet.'
  const { state, text } = await loadState($, root)
  if (state.kind === 'missing' || text === null) return `Not approved: there is no ${CONFIG_PATH} in ${root}.`
  if (state.kind === 'unreadable') return `Not approved: ${CONFIG_PATH} could not be read (${state.error}).`
  const parsed = parseChecksFile(text)
  if (!parsed.ok) return `Not approved: ${CONFIG_PATH} is invalid (${parsed.error}).`
  await $.store.set(approvalKey(root), { text, approvedAt: await $.clock.now() })
  return `Approved ${CONFIG_PATH} for ${root}. After each edit it may run:\n${planText(parsed.value)}\nAny change to the file needs approval again.`
}

export const register: Register = (on, options) => {
  config = configFrom(options)
  loadId = newId()

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    const stat = await $.fs.stat(e.cwd, { resolve: true }).catch(() => undefined)
    root = stat?.realPath ?? e.cwd
    await $.command.register({
      name: NAME,
      description: 'Show or set edit-diagnostics for this session, or approve its config',
      argumentHint: '[status|on|off|approve|revoke]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'approve') {
      const text = await approve($, e.origin.kind)
      return { text }
    }
    if (cmd.kind === 'revoke') {
      if (root !== null) await $.store.delete(approvalKey(root))
      await update($, sessionAtom, s => ({ ...s, running: null, pending: [] }))
    }
    if (cmd.kind === 'set') {
      await update($, sessionAtom, (s): Session => (cmd.mode === 'off' ? { ...s, mode: 'off', running: null, pending: [] } : { ...s, mode: 'on' }))
    }
    const session = await read($, sessionAtom)
    const state = root === null ? ({ kind: 'missing' } as const) : (await loadState($, root)).state
    const prefix = cmd.kind === 'revoke' ? 'Approval revoked.\n' : ''
    return { text: `${prefix}${statusText({ config, session, root, state })}` }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError === true || e.agentId !== undefined) return r
    const path = mutatedPath(e as unknown as { tool: unknown } & Record<string, unknown>)
    if (path === null) return r
    let note: string | null
    try {
      note = await afterMutation($, path)
    } catch (err) {
      log($, `failed after an edit: ${errText(err)}`)
      note = `edit-diagnostics: failed internally (${err instanceof Error ? err.name : 'error'}); this edit is not verified.`
    }
    return note === null ? r : { ...r, context: [...(r.context ?? []), note] }
  }).catch(($, e, next) => next(e)) // fail open: the native result always stands

  // Batch delivery hooks are registered only in batch mode: on hosts where a
  // managed plugin skips classic.PostToolBatch, the engine tells the model
  // about every skipped hook, which would be noise in tool mode.
  if (config.delivery !== 'batch') return
  on('classic.PostToolBatch', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id !== undefined || root === null) return r
    const s = await update($, sessionAtom, v => ({ ...v, batchRuns: v.batchRuns + 1 }))
    if (!isActive(config, s) || s.pending.length === 0) return r
    let text: string | null
    try {
      const { state } = await loadState($, root)
      text = state.kind === 'approved' ? await runPending($, root, state.file) : null
    } catch (err) {
      log($, `batch run failed: ${errText(err)}`)
      text = `edit-diagnostics: failed internally (${err instanceof Error ? err.name : 'error'}); this batch's edits are not verified.`
    }
    if (text === null || text === BUSY_NOTE) return r
    return { ...r, additionalContext: [...(r.additionalContext ?? []), text] }
  }).catch(($, e, next) => next(e))

  // Batch-mode health: edits still pending when the next main turn starts mean
  // the batch hook never reached this mod. Said once per session.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    let isNew = false
    await update($, sessionAtom, s => {
      isNew = s.pending.length > 0 && s.running === null && !s.notices.includes(BATCH_SKIPPED)
      return isNew ? { ...s, notices: [...s.notices, BATCH_SKIPPED] } : s
    })
    if (isNew) {
      const msg = 'classic.PostToolBatch did not reach this mod, so edits stay unverified. Set the delivery option to tool.'
      log($, msg)
      if (isInteractive) {
        try {
          $.ui.toast(msg)
        } catch {
          // best effort
        }
      }
    }
    return next(e)
  })
}
