// Pure decisions: no `$`, no I/O. register.ts only wires them to events.
import type { Check, ChecksFile, Config, Delivery, Finding, Mode, ParserName, ParseResult, Session, Snapshots } from '../types'

export const INITIAL: Session = { mode: null, pending: [], running: null, snapshots: {}, lastRun: [], notices: [], mutations: 0, batchRuns: 0 }

export const CONFIG_PATH = '.claude/edit-diagnostics.json'
export const MAX_CONFIG_CHARS = 16384
export const MAX_CHECKS = 4
export const MAX_OPERANDS = 50
/** Combined stdout + stderr, in UTF-8 bytes. */
export const MAX_OUTPUT_BYTES = 512 * 1024
export const MAX_FINDINGS = 30
export const MAX_REPORT_CHARS = 8000
export const MAX_MESSAGE_CHARS = 400
export const MAX_SNAPSHOT_KEYS = 200
/** The UTF-8 byte length of `text`, one pass, no allocation (a lone surrogate counts 3, as its U+FFFD would). */
export function utf8Bytes(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

/** A check needs at least this much of the run's budget left to start. */
export const MIN_CHECK_MS = 500
const PARSERS: readonly ParserName[] = ['tsc', 'ruff-json', 'json']

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(hi, Math.max(lo, n))
}

export function configFrom(options: Record<string, unknown>): Config {
  const delivery: Delivery = options.delivery === 'batch' ? 'batch' : 'tool'
  return {
    enabled: options.enabled !== false,
    delivery,
    timeoutMs: clampInt(options.timeoutMs, 5000, 500, 30000),
    batchTimeoutMs: clampInt(options.batchTimeoutMs, 10000, 1000, 30000),
  }
}

export function isActive(config: Config, session: Session): boolean {
  return session.mode === null ? config.enabled : session.mode === 'on'
}

export type Command =
  | { kind: 'set'; mode: Mode }
  | { kind: 'status' }
  | { kind: 'approve' }
  | { kind: 'revoke' }
  | { kind: 'help'; error?: string }

export function parseArgs(args: string): Command {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'on' || word === 'off') return { kind: 'set', mode: word }
  if (word === 'approve') return { kind: 'approve' }
  if (word === 'revoke') return { kind: 'revoke' }
  if (word === 'help') return { kind: 'help' }
  return { kind: 'help', error: `Unknown argument: ${args.trim()}` }
}

export const USAGE = 'Usage: /edit-diagnostics [status|on|off|approve|revoke]'

// ---------------------------------------------------------------- paths

/** Folds a relative path (`.`/`..`/empty segments); null when absolute or escaping. `.` for the root. */
export function foldRelative(path: string): string | null {
  if (path.startsWith('/')) return null
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.length === 0 ? '.' : out.join('/')
}

/** `rel` against absolute `base` (or `rel` itself when absolute), folded; never above `/`. */
export function joinAbs(base: string, rel: string): string {
  const full = rel.startsWith('/') ? rel : `${base}/${rel}`
  const out: string[] = []
  for (const seg of full.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

/** `abs` relative to `root` when strictly inside it, else null. */
export function relativeToRoot(root: string, abs: string): string | null {
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!abs.startsWith(prefix)) return null
  const rest = foldRelative(abs.slice(prefix.length))
  return rest === null || rest === '.' ? null : rest
}

const UNSUPPORTED_GLOB = /^!|[{}[\]]/

/** `*` within a folder, `**` across folders, `?` one character; everything else literal. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^$()|\\/]/g, m => `\\${m}`)
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some(g => globToRegExp(g).test(path))
}

// ---------------------------------------------------------------- config file

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const CHECK_KEYS = ['id', 'argv', 'cwd', 'include', 'scope', 'parser']
const ID = /^[A-Za-z0-9_-]{1,32}$/

function isStringList(v: unknown, max: number): v is string[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(s => typeof s === 'string' && s !== '' && s.length <= 1000)
}

export function parseChecksFile(text: string): Parsed<ChecksFile> {
  if (text.length > MAX_CONFIG_CHARS) return { ok: false, error: `the file is over ${MAX_CONFIG_CHARS} characters` }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  if (!isRecord(json)) return { ok: false, error: 'the file must hold a JSON object' }
  const extra = Object.keys(json).find(k => k !== 'version' && k !== 'checks')
  if (extra !== undefined) return { ok: false, error: `unknown key: ${extra}` }
  if (json['version'] !== 1) return { ok: false, error: 'version must be 1' }
  const list = json['checks']
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CHECKS) return { ok: false, error: `checks must be a list of 1 to ${MAX_CHECKS} checks` }
  const checks: Check[] = []
  const ids = new Set<string>()
  for (let i = 0; i < list.length; i++) {
    const c: unknown = list[i]
    const at = `check ${i + 1}`
    if (!isRecord(c)) return { ok: false, error: `${at}: must be an object` }
    const unknownKey = Object.keys(c).find(k => !CHECK_KEYS.includes(k))
    if (unknownKey !== undefined) return { ok: false, error: `${at}: unknown key: ${unknownKey}` }
    const id = c['id']
    if (typeof id !== 'string' || !ID.test(id)) return { ok: false, error: `${at}: id must be 1 to 32 letters, digits, _ or -` }
    if (ids.has(id)) return { ok: false, error: `${at}: duplicate id ${id}` }
    ids.add(id)
    const argv = c['argv']
    if (!isStringList(argv, 32)) return { ok: false, error: `${at}: argv must be a list of 1 to 32 nonempty strings` }
    const rawCwd = c['cwd'] ?? '.'
    const cwd = typeof rawCwd === 'string' ? foldRelative(rawCwd) : null
    if (cwd === null) return { ok: false, error: `${at}: cwd must be a relative path inside the project` }
    const include = c['include']
    if (!isStringList(include, 32)) return { ok: false, error: `${at}: include must be a list of 1 to 32 patterns` }
    const badGlob = include.find(g => UNSUPPORTED_GLOB.test(g))
    if (badGlob !== undefined) return { ok: false, error: `${at}: include pattern ${badGlob} uses unsupported syntax (only *, ** and ? are supported)` }
    const scope = c['scope']
    if (scope !== 'files' && scope !== 'project') return { ok: false, error: `${at}: scope must be files or project` }
    const parser = c['parser']
    if (typeof parser !== 'string' || !(PARSERS as readonly string[]).includes(parser)) return { ok: false, error: `${at}: parser must be tsc, ruff-json or json` }
    checks.push({ id, argv: [...argv], cwd, include: [...include], scope, parser: parser as ParserName })
  }
  return { ok: true, value: { version: 1, checks } }
}

export type ConfigState =
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'unapproved'; file: ChecksFile }
  | { kind: 'changed'; file: ChecksFile }
  | { kind: 'approved'; file: ChecksFile }

/** The config's text (null when missing) against the approved text for this root. */
export function configState(text: string | null, approved: string | undefined): ConfigState {
  if (text === null) return { kind: 'missing' }
  const parsed = parseChecksFile(text)
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error }
  if (approved === undefined) return { kind: 'unapproved', file: parsed.value }
  if (approved !== text) return { kind: 'changed', file: parsed.value }
  return { kind: 'approved', file: parsed.value }
}

/** A short, stable key for a config text, to say each notice once per text (not a security check). */
export function textKey(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${text.length}:${h.toString(16)}`
}

// ---------------------------------------------------------------- run plan

export type Plan = {
  check: Check
  argv: string[]
  cwdAbs: string
  /** Root-relative edited files the check covers this run. */
  files: string[]
  /** Matched files left out over the operand limit. */
  notChecked: number
}

function operand(file: string, cwd: string, root: string): string {
  let rel: string
  if (cwd === '.') rel = file
  else if (file.startsWith(`${cwd}/`)) rel = file.slice(cwd.length + 1)
  else return `${root}/${file}`
  // Always `./`: a bare name can read as an option (`-x`) or a response file
  // (`@x`, which tsc expands into arguments from the repository's own file).
  return `./${rel}`
}

/** Which checks run for these root-relative edited paths, with their exact argv. */
export function planRun(checks: readonly Check[], root: string, paths: readonly string[]): Plan[] {
  const plans: Plan[] = []
  for (const check of checks) {
    const matched = [...new Set(paths)].filter(p => matchesAny(check.include, p))
    if (matched.length === 0) continue
    const cwdAbs = check.cwd === '.' ? root : `${root}/${check.cwd}`
    const head = check.argv[0]!
    const exe = head.startsWith('./') || head.startsWith('../') ? joinAbs(cwdAbs, head) : head
    const files = check.scope === 'files' ? matched.slice(0, MAX_OPERANDS) : matched
    const argv = [exe, ...check.argv.slice(1), ...(check.scope === 'files' ? files.map(f => operand(f, check.cwd, root)) : [])]
    plans.push({ check, argv, cwdAbs, files, notChecked: matched.length - files.length })
  }
  return plans
}

/** At most this many distinct finding paths per check are resolved on disk; the rest keep their spelling. */
export const MAX_RESOLVED_PATHS = 200

/** The distinct absolute paths a parse names, as spelled (relative ones against the check's cwd). */
export function findingPaths(parsed: ParseResult, cwdAbs: string): string[] {
  if (!parsed.ok) return []
  const out = new Set<string>()
  for (const f of parsed.findings) if (f.file !== null) out.add(joinAbs(cwdAbs, f.file))
  return [...out].slice(0, MAX_RESOLVED_PATHS)
}

/**
 * The parse with every finding's file replaced by where it lands on disk
 * (`real`: spelled absolute path → realPath), so a finding reached through a
 * link inside the project has the edited file's identity. Unresolved paths
 * keep their absolute spelling.
 */
export function withRealPaths(parsed: ParseResult, cwdAbs: string, real: ReadonlyMap<string, string>): ParseResult {
  if (!parsed.ok) return parsed
  return {
    ok: true,
    findings: parsed.findings.map(f => {
      if (f.file === null) return f
      const abs = joinAbs(cwdAbs, f.file)
      return { ...f, file: real.get(abs) ?? abs }
    }),
  }
}

// ---------------------------------------------------------------- novelty

export type Group = {
  /** Snapshot key: `<check id>\u0000<file>`, file empty for project-level findings. */
  key: string
  fp: string
  /** Current occurrences, files root-relative. */
  findings: Finding[]
}

export type CheckOutcome =
  | { kind: 'failed'; id: string; parser: ParserName; reason: string }
  | { kind: 'skipped'; id: string; parser: ParserName; reason: string }
  | {
      kind: 'ok'
      id: string
      parser: ParserName
      files: string[]
      unbaselined: string[]
      groups: Group[]
      still: number
      other: { count: number; files: number }
      observed: Snapshots
      notChecked?: number
    }

function fnv1a(text: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Identity of a finding within its check and file: severity, code and the
 * whole whitespace-collapsed message. A message over 300 characters is kept
 * as its first 200, its length and two 32-bit hashes of all of it, so the
 * stored snapshot stays small while any change anywhere in it is a new
 * identity. Display truncation (MAX_MESSAGE_CHARS) is separate.
 */
export function fingerprint(f: Finding): string {
  const full = f.message.replace(/\s+/g, ' ').trim()
  const message = full.length <= 300 ? full : `${full.slice(0, 200)}…#${full.length}:${fnv1a(full, 0x811c9dc5)}${fnv1a(full, 0x01000193)}`
  return `${f.severity}\u0002${f.code ?? ''}\u0002${message}`
}

/** One check's parsed output against the last observed snapshot, for the edited files it covered. */
export function assessCheck(check: Check, parsed: ParseResult, covered: readonly string[], root: string, cwdAbs: string, snapshots: Snapshots): CheckOutcome {
  if (!parsed.ok) return { kind: 'failed', id: check.id, parser: check.parser, reason: parsed.reason }
  const coveredSet = new Set(covered)
  const projectKey = `${check.id}\u0000`
  const observed: Snapshots = {}
  for (const file of covered) observed[`${check.id}\u0000${file}`] = {}
  const groups = new Map<string, Group>()
  const otherFiles = new Set<string>()
  let otherCount = 0
  for (const raw of parsed.findings) {
    let file: string | null = null
    if (raw.file !== null) {
      const abs = joinAbs(cwdAbs, raw.file)
      file = relativeToRoot(root, abs) ?? abs
    }
    if (file !== null && !coveredSet.has(file)) {
      otherCount++
      otherFiles.add(file)
      continue
    }
    const key = file === null ? projectKey : `${check.id}\u0000${file}`
    const finding = { ...raw, file }
    const fp = fingerprint(finding)
    const counts = (observed[key] ??= {})
    counts[fp] = (Object.hasOwn(counts, fp) ? counts[fp]! : 0) + 1
    const gk = `${key}\u0001${fp}`
    const g = groups.get(gk)
    if (g === undefined) groups.set(gk, { key, fp, findings: [finding] })
    else g.findings.push(finding)
  }
  if (observed[projectKey] === undefined && Object.hasOwn(snapshots, projectKey)) observed[projectKey] = {}
  const fresh: Group[] = []
  let still = 0
  for (const g of groups.values()) {
    const prev = Object.hasOwn(snapshots, g.key) && Object.hasOwn(snapshots[g.key]!, g.fp) ? snapshots[g.key]![g.fp]! : 0
    if (g.findings.length > prev) fresh.push(g)
    else still += g.findings.length
  }
  return {
    kind: 'ok',
    id: check.id,
    parser: check.parser,
    files: [...covered],
    unbaselined: covered.filter(f => !Object.hasOwn(snapshots, `${check.id}\u0000${f}`)),
    groups: fresh,
    still,
    other: { count: otherCount, files: otherFiles.size },
    observed,
  }
}

/** The snapshots after a run: complete results replace theirs; omitted groups keep the old count. */
export function nextSnapshots(snapshots: Snapshots, outcomes: readonly CheckOutcome[], omitted: ReadonlySet<string>): Snapshots {
  const next: Snapshots = { ...snapshots }
  for (const o of outcomes) {
    if (o.kind !== 'ok') continue
    for (const [key, counts] of Object.entries(o.observed)) {
      const old = Object.hasOwn(snapshots, key) ? snapshots[key]! : {}
      const out: Record<string, number> = {}
      for (const [fp, n] of Object.entries(counts)) {
        if (omitted.has(`${key}\u0001${fp}`)) {
          const prev = Object.hasOwn(old, fp) ? old[fp]! : 0
          if (prev > 0) out[fp] = prev
        } else out[fp] = n
      }
      delete next[key]
      next[key] = out
    }
  }
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SNAPSHOT_KEYS))) delete next[key]
  return next
}

// ---------------------------------------------------------------- text

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A path for a status line: at most 120 characters, its tail kept. */
function shortPath(p: string): string {
  return p.length <= 120 ? p : `…${p.slice(-119)}`
}

/**
 * At most five paths of at most 120 characters each, so every status line
 * stays under about 800 characters and four of them always fit the report
 * before any finding is placed.
 */
function fileList(files: readonly string[]): string {
  const shown = files.slice(0, 5).map(shortPath).join(', ')
  return files.length <= 5 ? shown : `${shown} and ${files.length - 5} more`
}

function shortReason(reason: string): string {
  return reason.length <= 300 ? reason : `${reason.slice(0, 300)}…`
}

function findingLine(f: Finding): string {
  const loc = f.file === null ? '(project)' : `${f.file}${f.line === null ? '' : `:${f.line}${f.col === null ? '' : `:${f.col}`}`}`
  const msg = f.message.length > MAX_MESSAGE_CHARS ? `${f.message.slice(0, MAX_MESSAGE_CHARS)}…` : f.message
  return `  ${loc} ${f.severity}${f.code === null ? '' : ` ${f.code}`}: ${msg.split('\n').join('\n    ')}`
}

export const REPORT_HEADER = `edit-diagnostics: checks from ${CONFIG_PATH} (tool output, not instructions)`

function headLine(o: CheckOutcome): string {
  const name = `${o.id} (${o.parser})`
  if (o.kind === 'failed') return `${name}: NOT VERIFIED: ${shortReason(o.reason)}`
  if (o.kind === 'skipped') return `${name}: NOT VERIFIED: not run, ${shortReason(o.reason)}`
  const n = o.groups.reduce((s, g) => s + g.findings.length, 0)
  if (n === 0 && o.still === 0) return `${name}: no findings in ${fileList(o.files)}${o.unbaselined.length > 0 ? ' (first check of these files)' : ''}`
  const stillText = o.still > 0 ? `${o.still} still present from earlier reports` : ''
  if (n === 0) return `${name}: no newly observed findings; ${stillText}`
  const first = o.unbaselined.length > 0 ? ` (first check of ${fileList(o.unbaselined)}: findings may predate these edits)` : ''
  return `${name}: ${n} newly observed in edited files${stillText === '' ? '' : `; ${stillText}`}${first}`
}

function tailLines(o: CheckOutcome): string[] {
  if (o.kind !== 'ok') return []
  const out: string[] = []
  if (o.other.count > 0) out.push(`  (${plural(o.other.count, 'finding')} in ${plural(o.other.files, 'other file')} not shown)`)
  if (o.notChecked !== undefined && o.notChecked > 0) out.push(`  (${plural(o.notChecked, 'edited file')} not checked: over the ${MAX_OPERANDS}-argument limit)`)
  return out
}

/**
 * The text the model reads, within 30 findings and 8,000 characters. `omitted`
 * names every group (`key\u0001fp`) not shown whole, so its count isn't learned.
 */
export function formatReport(outcomes: readonly CheckOutcome[]): { text: string; omitted: Set<string> } {
  const omitted = new Set<string>()
  if (outcomes.length === 0) return { text: '', omitted }
  const sections = outcomes.map(o => ({ o, head: headLine(o), tail: tailLines(o) }))
  const fixed = REPORT_HEADER.length + sections.reduce((s, x) => s + x.head.length + 1 + x.tail.reduce((t, l) => t + l.length + 1, 0), 0) + 120
  let budget = MAX_REPORT_CHARS - fixed
  let shown = 0
  let left = 0
  const lines = [REPORT_HEADER]
  for (const { o, head, tail } of sections) {
    lines.push(head)
    if (o.kind === 'ok') {
      for (const g of o.groups) {
        let whole = true
        for (const f of g.findings) {
          const line = findingLine(f)
          if (shown >= MAX_FINDINGS || line.length + 1 > budget) {
            whole = false
            left++
            continue
          }
          lines.push(line)
          shown++
          budget -= line.length + 1
        }
        if (!whole) omitted.add(`${g.key}\u0001${g.fp}`)
      }
    }
    lines.push(...tail)
  }
  if (left > 0) lines.push(`  (${left} more newly observed ${left === 1 ? 'finding' : 'findings'} not shown: report limit)`)
  let text = lines.join('\n')
  if (text.length > MAX_REPORT_CHARS) text = `${text.slice(0, MAX_REPORT_CHARS - 40)}\n(report cut at ${MAX_REPORT_CHARS} characters)`
  return { text, omitted }
}

// ---------------------------------------------------------------- notes

export const PENDING_NOTE = 'edit-diagnostics: checks run after this batch of tool calls; this edit is not verified yet.'
export const BUSY_NOTE = 'edit-diagnostics: an earlier check run is still going; this edit is queued for the next run and not verified yet.'

export function inactiveNote(state: ConfigState, isInteractive: boolean): string | null {
  const how = isInteractive ? 'The person can approve it with /edit-diagnostics approve.' : 'It can be approved only in an interactive session (/edit-diagnostics approve).'
  if (state.kind === 'unapproved') return `edit-diagnostics: ${CONFIG_PATH} is not approved, so no checks ran. ${how}`
  if (state.kind === 'changed') return `edit-diagnostics: ${CONFIG_PATH} changed since it was approved, so no checks ran. ${how}`
  if (state.kind === 'invalid') return `edit-diagnostics: ${CONFIG_PATH} is invalid (${state.error}), so no checks ran.`
  if (state.kind === 'unreadable') return `edit-diagnostics: ${CONFIG_PATH} could not be read (${state.error}), so no checks ran.`
  return null
}

export function noticeKey(state: ConfigState, text: string | null): string {
  return `${state.kind}:${text === null ? '' : textKey(text)}`
}

export function planText(file: ChecksFile): string {
  return file.checks
    .map(c => `  ${c.id}: ${JSON.stringify(c.argv)} in ${c.cwd}, ${c.scope} scope, ${c.parser} parser, for ${c.include.join(' ')}`)
    .join('\n')
}

export type StatusFacts = {
  config: Config
  session: Session
  root: string | null
  state: ConfigState
}

export function statusText(f: StatusFacts): string {
  const { config, session, state } = f
  const on = isActive(config, session) ? 'on' : 'off'
  const source = session.mode === null ? 'from the enabled option' : 'set for this session'
  const lines = [`${on} (${source}); delivery ${config.delivery}; timeouts ${config.timeoutMs} ms per check, ${config.batchTimeoutMs} ms per run.`]
  lines.push(`Project: ${f.root ?? 'unknown'}`)
  const where = CONFIG_PATH
  if (state.kind === 'missing') lines.push(`Config: no ${where}; nothing runs.`)
  else if (state.kind === 'unreadable') lines.push(`Config: ${where} could not be read (${state.error}); nothing runs.`)
  else if (state.kind === 'invalid') lines.push(`Config: ${where} is invalid (${state.error}); nothing runs.`)
  else {
    const label = state.kind === 'approved' ? 'approved' : state.kind === 'changed' ? 'changed since approval; nothing runs until /edit-diagnostics approve' : 'not approved; nothing runs until /edit-diagnostics approve'
    lines.push(`Config: ${where}, ${label}. Checks:`, planText(state.file))
  }
  lines.push(`Covered edits seen: ${session.mutations}; pending: ${session.pending.length}${session.running === null ? '' : '; a run is in progress'}; batch hook runs: ${session.batchRuns}.`)
  if (session.lastRun.length > 0) lines.push('Last run:', ...session.lastRun.map(l => `  ${l}`))
  return lines.join('\n')
}

/** One line per outcome for the status command. */
export function summaryLines(outcomes: readonly CheckOutcome[]): string[] {
  return outcomes.map(o => headLine(o).slice(0, 300))
}
