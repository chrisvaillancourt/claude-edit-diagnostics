import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/work/proj'
const CONFIG = `${ROOT}/.claude/edit-diagnostics.json`
const COMPOSER = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const SDK = { origin: { kind: 'sdk' as const }, presentation: { isFullscreen: false, columns: 120 } }

const TYPES = { id: 'types', argv: ['./node_modules/.bin/tsc', '--noEmit', '--pretty', 'false'], include: ['src/**/*.ts'], scope: 'project', parser: 'tsc' }
const LINT = { id: 'lint', argv: ['lintwrap'], include: ['src/**/*.ts'], scope: 'files', parser: 'json' }
const configText = (...checks: object[]) => JSON.stringify({ version: 1, checks: checks.length === 0 ? [TYPES] : checks })

type Out = { exitCode: number; stdout: string; stderr?: string } | { deny: string } | ((argv: string[]) => { exitCode: number; stdout: string; stderr?: string } | { deny: string })

/** The engine beneath the plugin: a project at /work/proj, its files, a scripted process runner. */
const world = (on: On, opts: { files?: Record<string, string>; approved?: string | null; outputs?: Record<string, Out>; links?: Record<string, string> } = {}) => {
  const text = configText()
  const files: Record<string, string> = { [CONFIG]: text, [`${ROOT}/src/a.ts`]: '', [`${ROOT}/src/b.ts`]: '', [`${ROOT}/README.md`]: '', ...opts.files }
  const approved = opts.approved === undefined ? text : opts.approved
  mock.store(on, approved === null ? {} : { [`approval:${ROOT}`]: { text: approved } })
  const clock = mock.clock(on, { now: 1000 })
  const dirs = new Set([ROOT, `${ROOT}/.claude`, `${ROOT}/src`])
  /** Symbolic links inside the project: a spelling and the real path it lands on. */
  const links = opts.links ?? {}
  on('fs.stat', ($, e) => {
    const spelled = e.path.startsWith('/') ? e.path : `${ROOT}/${e.path}`
    const path = links[spelled] ?? spelled
    if (dirs.has(path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: path } : {}) } }
    if (files[path] === undefined) return { deny: 'ENOENT' }
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: path } : {}) } }
  })
  on('fs.exists', ($, e) => ({ value: files[e.path] !== undefined || dirs.has(e.path) }))
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: `ENOENT: no such file, open '${e.path}'` } : { value: files[e.path]! }))
  const outputs: Record<string, Out> = { tsc: { exitCode: 0, stdout: '' }, lintwrap: { exitCode: 0, stdout: '{"version":1,"findings":[]}' }, ...opts.outputs }
  const runs: { argv: string[]; cwd?: string; timeoutMs?: number }[] = []
  /** Runs while a process is "running", to simulate events arriving meanwhile. */
  const during: (() => Promise<unknown>)[] = []
  on('process.run', async ($, e) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    const step = during.shift()
    if (step !== undefined) await step()
    const name = e.argv[0]!.split('/').pop()!
    let out = outputs[name]
    if (typeof out === 'function') out = out([...e.argv])
    if (out === undefined) return { deny: `spawn ${e.argv[0]} ENOENT` }
    if ('deny' in out) return { deny: out.deny }
    return { value: { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(String((e as any).text ?? ''))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }) as any)
  let nextError = false
  let nextDeny = false
  on('tool.call', ($, e) => {
    if (nextDeny) {
      nextDeny = false
      return { deny: 'no' }
    }
    if (nextError) {
      nextError = false
      return { result: 'Error: old_string not found', text: 'Error: old_string not found', isError: true as const, ref: 9 }
    }
    return { result: { type: 'update', filePath: String((e as any).file_path ?? (e as any).notebook_path) } as any, text: 'The file was updated.', ref: 7 }
  })
  on('classic.PostToolBatch', () => ({ additionalContext: ['from below'] }))
  return { files, runs, logs, during, outputs, clock, setError: () => (nextError = true), setDeny: () => (nextDeny = true) }
}

const start = ($: any, isInteractive = true) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive })
const write = ($: any, path: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Write', file_path: path, content: 'x', tool_use_id: `tu-${path}`, ...extra })
const edit = ($: any, path: string) => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', tool_use_id: `tu-e-${path}` })
const cmd = ($: any, args: string, how: { origin: { kind: string }; presentation: object } = COMPOSER) => $.command.run({ command: 'edit-diagnostics', args, ...how })
const ctx = (r: any): string => (r.context ?? []).join('\n')

const TSC_ERR = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"

describe('tool delivery', () => {
  test('a successful Write runs the approved checks and appends findings, keeping the native result', async ($, on) => {
    const w = world(on, { outputs: { tsc: { exitCode: 2, stdout: TSC_ERR } } })
    await start($)
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(w.runs).toEqual([{ argv: [`${ROOT}/node_modules/.bin/tsc`, '--noEmit', '--pretty', 'false'], cwd: ROOT, timeoutMs: 5000 }])
    expect(r.ref).toBe(7)
    expect(r.text).toBe('The file was updated.')
    expect(r.result).toEqual({ type: 'update', filePath: `${ROOT}/src/a.ts` })
    expect(ctx(r)).toContain("types (tsc): 1 newly observed in edited files (first check of src/a.ts: findings may predate these edits)")
    expect(ctx(r)).toContain("  src/a.ts:1:7 error TS2322: Type 'string' is not assignable to type 'number'.")
  })

  test('a repeated finding is counted, not repeated; a fix reports clean', async ($, on) => {
    const w = world(on, { outputs: { tsc: { exitCode: 2, stdout: TSC_ERR } } })
    await start($)
    await write($, `${ROOT}/src/a.ts`)
    const again = await edit($, `${ROOT}/src/a.ts`)
    expect(ctx(again)).toContain('types (tsc): no newly observed findings; 1 still present from earlier reports')
    expect(ctx(again)).not.toContain('TS2322')
    w.outputs.tsc = { exitCode: 0, stdout: '' }
    const fixed = await edit($, `${ROOT}/src/a.ts`)
    expect(ctx(fixed)).toContain('types (tsc): no findings in src/a.ts')
    expect(ctx(fixed)).not.toContain('first check')
  })

  test('denied, errored and subagent calls run nothing and pass through untouched', async ($, on) => {
    const w = world(on)
    await start($)
    w.setDeny()
    expect(await write($, `${ROOT}/src/a.ts`)).toEqual({ deny: 'no' })
    w.setError()
    const err = await edit($, `${ROOT}/src/a.ts`)
    expect(err.isError).toBe(true)
    expect(err.context).toBe(undefined)
    const sub = await write($, `${ROOT}/src/a.ts`, { agentId: 'a1' })
    expect(sub.context).toBe(undefined)
    expect(w.runs.length).toBe(0)
  })

  test('files outside the project or outside every include run nothing', async ($, on) => {
    const w = world(on, { files: { '/elsewhere/x.ts': '' } })
    await start($)
    expect((await write($, '/elsewhere/x.ts')).context).toBe(undefined)
    expect((await write($, `${ROOT}/README.md`)).context).toBe(undefined)
    expect(w.runs.length).toBe(0)
  })

  test('a files check gets the edited file as its own argument; one failure does not hide another check', async ($, on) => {
    const text = configText({ ...TYPES, argv: ['missing-tsc'] }, LINT)
    const w = world(on, {
      approved: text,
      files: { [CONFIG]: text },
      outputs: { lintwrap: { exitCode: 1, stdout: JSON.stringify({ version: 1, findings: [{ file: 'src/a.ts', line: 2, col: 3, severity: 'warning', code: 'W1', message: 'unused' }] }) } },
    })
    await start($)
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.map(x => x.argv)).toEqual([['missing-tsc'], ['lintwrap', './src/a.ts']])
    expect(ctx(r)).toContain('types (tsc): NOT VERIFIED: could not run: spawn missing-tsc ENOENT')
    expect(ctx(r)).toContain('  src/a.ts:2:3 warning W1: unused')
  })

  test('malformed output and an empty failing run are not verified and teach nothing', async ($, on) => {
    const w = world(on, { outputs: { tsc: { exitCode: 2, stdout: 'Segmentation fault\n' } } })
    await start($)
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(ctx(r)).toContain("types (tsc): NOT VERIFIED: unrecognized tsc output at line 1: 'Segmentation fault'")
    w.outputs.tsc = { exitCode: 1, stdout: '' }
    expect(ctx(await edit($, `${ROOT}/src/a.ts`))).toContain('types (tsc): NOT VERIFIED: exit code 1 with no findings')
    w.outputs.tsc = { exitCode: 2, stdout: TSC_ERR }
    // Still the first complete observation: unbaselined, shown in full.
    expect(ctx(await edit($, `${ROOT}/src/a.ts`))).toContain('first check of src/a.ts')
  })

  test('a check that would start past the run budget is not run', async ($, on) => {
    const text = configText(TYPES, { ...LINT, id: 'lint2' })
    const w = world(on, { approved: text, files: { [CONFIG]: text } })
    await start($)
    w.during.push(async () => w.clock.advance(9800))
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.length).toBe(1)
    expect(ctx(r)).toContain('lint2 (json): NOT VERIFIED: not run, time budget used up')
  })

  test('an edit while a run is going is queued and covered by the next run', async ($, on) => {
    const text = configText(LINT)
    const w = world(on, { approved: text, files: { [CONFIG]: text } })
    await start($)
    let inner: any
    w.during.push(async () => {
      inner = await write($, `${ROOT}/src/b.ts`)
    })
    const outer = await write($, `${ROOT}/src/a.ts`)
    expect(ctx(inner)).toContain('an earlier check run is still going')
    expect(ctx(outer)).toContain('lint (json): no findings in src/a.ts')
    await edit($, `${ROOT}/src/a.ts`)
    expect(w.runs.map(x => x.argv)).toEqual([['lintwrap', './src/a.ts'], ['lintwrap', './src/b.ts', './src/a.ts']])
  })

  test('off during a run drops its results', async ($, on) => {
    const w = world(on, { outputs: { tsc: { exitCode: 2, stdout: TSC_ERR } } })
    await start($)
    w.during.push(() => cmd($, 'off'))
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(r.context).toBe(undefined)
    expect(w.runs.length).toBe(1)
    await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.length).toBe(1)
  })
  test('off during the first of two checks: the second never starts', async ($, on) => {
    const text = configText(TYPES, LINT)
    const w = world(on, { approved: text, files: { [CONFIG]: text } })
    await start($)
    w.during.push(() => cmd($, 'off'))
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.map(x => x.argv[0])).toEqual([`${ROOT}/node_modules/.bin/tsc`])
    expect(r.context).toBe(undefined)
  })

  test('revoke during the first of two checks: the second never starts', async ($, on) => {
    const text = configText(TYPES, LINT)
    const w = world(on, { approved: text, files: { [CONFIG]: text } })
    await start($)
    w.during.push(() => cmd($, 'revoke'))
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.map(x => x.argv[0])).toEqual([`${ROOT}/node_modules/.bin/tsc`])
    expect(r.context).toBe(undefined)
  })
})

describe('paths', () => {
  test('a finding reported through an internal symlink belongs to the edited file', async ($, on) => {
    const w = world(on, {
      files: { [`${ROOT}/real/a.ts`]: '' },
      links: { [`${ROOT}/linked/a.ts`]: `${ROOT}/real/a.ts` },
      outputs: { tsc: { exitCode: 2, stdout: "linked/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n" } },
    })
    w.files[CONFIG] = configText({ ...TYPES, include: ['**/*.ts'] })
    await start($)
    await cmd($, 'approve')
    const r = await write($, `${ROOT}/real/a.ts`)
    expect(ctx(r)).toContain('types (tsc): 1 newly observed in edited files')
    expect(ctx(r)).toContain("  real/a.ts:1:14 error TS2322: Type 'string' is not assignable to type 'number'.")
    expect(ctx(r)).not.toContain('other file')
  })
})

describe('approval', () => {
  test('an unapproved config runs nothing and says so once', async ($, on) => {
    const w = world(on, { approved: null })
    await start($)
    const first = await write($, `${ROOT}/src/a.ts`)
    expect(ctx(first)).toContain('.claude/edit-diagnostics.json is not approved, so no checks ran')
    expect((await edit($, `${ROOT}/src/a.ts`)).context).toBe(undefined)
    expect(w.runs.length).toBe(0)
  })

  test('approve stores the exact text from the composer and refuses other origins', async ($, on) => {
    const w = world(on, { approved: null })
    await start($)
    const refused = await cmd($, 'approve', SDK)
    expect(refused.text).toContain('Not approved: approval must be typed at the prompt')
    expect((await cmd($, 'approve', { ...COMPOSER, origin: { kind: 'plugin', name: 'other' } } as any)).text).toContain('Not approved')
    const ok = await cmd($, 'approve')
    expect(ok.text).toContain('Approved .claude/edit-diagnostics.json')
    expect(ok.text).toContain('types: ["./node_modules/.bin/tsc","--noEmit","--pretty","false"]')
    await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.length).toBe(1)
  })

  test('a changed config needs approval again; revoke stops runs', async ($, on) => {
    const w = world(on)
    await start($)
    w.files[CONFIG] = configText(LINT)
    const r = await write($, `${ROOT}/src/a.ts`)
    expect(ctx(r)).toContain('changed since it was approved')
    expect(w.runs.length).toBe(0)
    expect((await cmd($, 'status')).text).toContain('changed since approval')
    await cmd($, 'approve')
    await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.length).toBe(1)
    await cmd($, 'revoke')
    await write($, `${ROOT}/src/a.ts`)
    expect(w.runs.length).toBe(1)
  })

  test('approve refuses an invalid config', async ($, on) => {
    const w = world(on, { approved: null })
    w.files[CONFIG] = '{"version":1,"checks":[]}'
    await start($)
    expect((await cmd($, 'approve')).text).toContain('Not approved: .claude/edit-diagnostics.json is invalid (checks must be a list of 1 to 4 checks)')
  })

  test('headless with no approval stays inactive and says it can only be approved interactively', async ($, on) => {
    world(on, { approved: null })
    await start($, false)
    expect(ctx(await write($, `${ROOT}/src/a.ts`))).toContain('can be approved only in an interactive session')
  })
})

describe('batch delivery', () => {
  test('edits get a pending note; the batch hook runs once over all of them', { options: { delivery: 'batch' } }, async ($, on) => {
    const text = configText(LINT)
    const w = world(on, { approved: text, files: { [CONFIG]: text } })
    await start($)
    const a = await write($, `${ROOT}/src/a.ts`)
    const b = await write($, `${ROOT}/src/b.ts`)
    expect(ctx(a)).toContain('checks run after this batch of tool calls; this edit is not verified yet')
    expect(ctx(b)).toContain('not verified yet')
    expect(w.runs.length).toBe(0)
    const r = await $.classic.PostToolBatch({ tool_calls: [{ tool_name: 'Write', tool_input: {}, tool_use_id: 'x' }] })
    expect(w.runs.map(x => x.argv)).toEqual([['lintwrap', './src/a.ts', './src/b.ts']])
    expect(r.additionalContext?.[0]).toBe('from below')
    expect(r.additionalContext?.[1]).toContain('lint (json): no findings in src/a.ts, src/b.ts')
  })

  test('pending edits at the next turn mean the batch hook was skipped: logged once', { options: { delivery: 'batch' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await write($, `${ROOT}/src/a.ts`)
    await $.turn.start({ text: 'next', turnId: 't2' })
    await $.turn.start({ text: 'next', turnId: 't3' })
    expect(w.logs.filter(l => l.includes('PostToolBatch')).length).toBe(1)
    expect((await cmd($, 'status')).text).toContain('pending: 1')
  })

  test('in tool mode the batch hook does nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await write($, `${ROOT}/src/a.ts`)
    const r = await $.classic.PostToolBatch({ tool_calls: [] })
    expect(r.additionalContext).toEqual(['from below'])
    expect(w.runs.length).toBe(1)
  })
})

describe('command', () => {
  test('status shows the plan and the state; unknown arguments get usage', async ($, on) => {
    world(on)
    await start($)
    const s = await cmd($, '')
    expect(s.text).toContain('on (from the enabled option); delivery tool')
    expect(s.text).toContain('Config: .claude/edit-diagnostics.json, approved.')
    expect((await cmd($, 'bogus')).text).toContain('Usage: /edit-diagnostics')
  })
})
