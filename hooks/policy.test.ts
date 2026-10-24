import { describe, expect, test } from 'claude-code/testing'

import {
  INITIAL,
  assessCheck,
  configFrom,
  configState,
  foldRelative,
  formatReport,
  globToRegExp,
  isActive,
  joinAbs,
  nextSnapshots,
  outputProblem,
  parseArgs,
  parseChecksFile,
  planRun,
  relativeToRoot,
} from './policy'
import type { CheckOutcome } from './policy'
import type { Check, Finding } from '../types'

const ROOT = '/work/proj'

const check = (over: Partial<Check> = {}): Check => ({
  id: 'types',
  argv: ['tsc', '--noEmit'],
  cwd: '.',
  include: ['src/**/*.ts'],
  scope: 'project',
  parser: 'tsc',
  ...over,
})

const fd = (file: string | null, line: number | null, message: string, code: string | null = 'TS2322'): Finding => ({
  file,
  line,
  col: line === null ? null : 1,
  severity: 'error',
  code,
  message,
})

describe('options and commands', () => {
  test('configFrom fills defaults and clamps limits', async () => {
    expect(configFrom({})).toEqual({ enabled: true, delivery: 'tool', timeoutMs: 5000, batchTimeoutMs: 10000 })
    expect(configFrom({ enabled: false, delivery: 'batch', timeoutMs: 10, batchTimeoutMs: 99999 })).toEqual({
      enabled: false,
      delivery: 'batch',
      timeoutMs: 500,
      batchTimeoutMs: 30000,
    })
    expect(configFrom({ delivery: 'bogus', timeoutMs: 'x' }).delivery).toBe('tool')
  })

  test('parseArgs reads every subcommand and rejects the rest', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' ON ')).toEqual({ kind: 'set', mode: 'on' })
    expect(parseArgs('off')).toEqual({ kind: 'set', mode: 'off' })
    expect(parseArgs('approve')).toEqual({ kind: 'approve' })
    expect(parseArgs('revoke')).toEqual({ kind: 'revoke' })
    expect(parseArgs('bogus')).toEqual({ kind: 'help', error: 'Unknown argument: bogus' })
  })

  test('a session override beats the enabled option', async () => {
    expect(isActive(configFrom({}), INITIAL)).toBe(true)
    expect(isActive(configFrom({ enabled: false }), INITIAL)).toBe(false)
    expect(isActive(configFrom({ enabled: false }), { ...INITIAL, mode: 'on' })).toBe(true)
    expect(isActive(configFrom({}), { ...INITIAL, mode: 'off' })).toBe(false)
  })
})

describe('config file', () => {
  const good = { version: 1, checks: [{ id: 'types', argv: ['tsc'], include: ['src/**/*.ts'], scope: 'project', parser: 'tsc' }] }

  test('a valid file parses, cwd defaulting to the root', async () => {
    expect(parseChecksFile(JSON.stringify(good))).toEqual({ ok: true, value: { version: 1, checks: [check({ argv: ['tsc'] })] } })
    const sub = { version: 1, checks: [{ ...good.checks[0], cwd: './pkg/../web/' }] }
    const r = parseChecksFile(JSON.stringify(sub))
    expect(r.ok && r.value.checks[0]!.cwd).toBe('web')
  })

  const bad: [string, unknown, string][] = [
    ['not JSON', '{', 'not valid JSON'],
    ['wrong version', { ...good, version: 2 }, 'version must be 1'],
    ['unknown top key', { ...good, extra: 1 }, 'unknown key: extra'],
    ['no checks', { version: 1, checks: [] }, 'checks must be a list of 1 to 4 checks'],
    ['five checks', { version: 1, checks: [1, 2, 3, 4, 5].map(i => ({ ...good.checks[0], id: `c${i}` })) }, 'checks must be a list of 1 to 4 checks'],
    ['duplicate id', { version: 1, checks: [good.checks[0], good.checks[0]] }, 'check 2: duplicate id types'],
    ['bad id', { version: 1, checks: [{ ...good.checks[0], id: 'a b' }] }, 'check 1: id must be 1 to 32 letters, digits, _ or -'],
    ['empty argv', { version: 1, checks: [{ ...good.checks[0], argv: [] }] }, 'check 1: argv must be a list of 1 to 32 nonempty strings'],
    ['shell string', { version: 1, checks: [{ ...good.checks[0], argv: 'tsc --noEmit' }] }, 'check 1: argv must be a list of 1 to 32 nonempty strings'],
    ['cwd escapes', { version: 1, checks: [{ ...good.checks[0], cwd: '../other' }] }, 'check 1: cwd must be a relative path inside the project'],
    ['absolute cwd', { version: 1, checks: [{ ...good.checks[0], cwd: '/etc' }] }, 'check 1: cwd must be a relative path inside the project'],
    ['negated glob', { version: 1, checks: [{ ...good.checks[0], include: ['!src/**'] }] }, 'check 1: include pattern !src/** uses unsupported syntax (only *, ** and ? are supported)'],
    ['brace glob', { version: 1, checks: [{ ...good.checks[0], include: ['src/*.{ts,tsx}'] }] }, 'check 1: include pattern src/*.{ts,tsx} uses unsupported syntax (only *, ** and ? are supported)'],
    ['no include', { version: 1, checks: [{ ...good.checks[0], include: [] }] }, 'check 1: include must be a list of 1 to 32 patterns'],
    ['bad scope', { version: 1, checks: [{ ...good.checks[0], scope: 'repo' }] }, 'check 1: scope must be files or project'],
    ['bad parser', { version: 1, checks: [{ ...good.checks[0], parser: 'eslint' }] }, 'check 1: parser must be tsc, ruff-json or json'],
    ['unknown check key', { version: 1, checks: [{ ...good.checks[0], shell: true }] }, 'check 1: unknown key: shell'],
    ['proto key', '{"version":1,"checks":[{"id":"a","argv":["x"],"include":["*"],"scope":"files","parser":"json","__proto__":{}}]}', 'check 1: unknown key: __proto__'],
  ]
  for (const [name, value, error] of bad) {
    test(`rejects: ${name}`, async () => {
      expect(parseChecksFile(typeof value === 'string' ? value : JSON.stringify(value))).toEqual({ ok: false, error })
    })
  }

  test('rejects a file over 16 KiB', async () => {
    expect(parseChecksFile(' '.repeat(16385))).toEqual({ ok: false, error: 'the file is over 16384 characters' })
  })

  test('configState compares the exact approved text', async () => {
    const text = JSON.stringify(good)
    expect(configState(null, undefined).kind).toBe('missing')
    expect(configState('{', undefined).kind).toBe('invalid')
    expect(configState(text, undefined).kind).toBe('unapproved')
    expect(configState(text, `${text} `).kind).toBe('changed')
    const s = configState(text, text)
    expect(s.kind).toBe('approved')
    expect(s.kind === 'approved' && s.file.checks.length).toBe(1)
    // An approval of an invalid text never makes it run.
    expect(configState('{', '{').kind).toBe('invalid')
  })
})

describe('globs and paths', () => {
  const cases: [string, string, boolean][] = [
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/deep/er/a.ts', true],
    ['src/**/*.ts', 'src/a.tsx', false],
    ['src/**/*.ts', 'lib/src/a.ts', false],
    ['*.py', 'a.py', true],
    ['*.py', 'pkg/a.py', false],
    ['**/*.py', 'pkg/a.py', true],
    ['**/*.py', 'a.py', true],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['a.b', 'axb', false],
    ['src/(x)+.ts', 'src/(x)+.ts', true],
  ]
  for (const [glob, path, expected] of cases) {
    test(`${glob} ${expected ? 'matches' : 'does not match'} ${path}`, async () => {
      expect(globToRegExp(glob).test(path)).toBe(expected)
    })
  }

  test('foldRelative folds and refuses escapes', async () => {
    expect(foldRelative('./a/../b/./c/')).toBe('b/c')
    expect(foldRelative('.')).toBe('.')
    expect(foldRelative('a/../..')).toBe(null)
    expect(foldRelative('/abs')).toBe(null)
  })

  test('joinAbs and relativeToRoot', async () => {
    expect(joinAbs('/work/proj/web', '../node_modules/.bin/tsc')).toBe('/work/proj/node_modules/.bin/tsc')
    expect(joinAbs('/work/proj', '/abs/x')).toBe('/abs/x')
    expect(relativeToRoot(ROOT, '/work/proj/src/a.ts')).toBe('src/a.ts')
    expect(relativeToRoot(ROOT, '/work/project/a.ts')).toBe(null)
    expect(relativeToRoot(ROOT, ROOT)).toBe(null)
  })
})

describe('planRun', () => {
  test('a project check appends nothing and runs when any edited file matches', async () => {
    const plans = planRun([check()], ROOT, ['src/a.ts', 'README.md'])
    expect(plans).toEqual([{ check: check(), argv: ['tsc', '--noEmit'], cwdAbs: ROOT, files: ['src/a.ts'], notChecked: 0 }])
    expect(planRun([check()], ROOT, ['README.md'])).toEqual([])
  })

  test('a files check appends separate operands relative to its cwd, each led by ./ so none reads as an option or response file', async () => {
    const c = check({ id: 'lint', scope: 'files', cwd: 'py', include: ['**/*.py'], argv: ['./bin/ruff', 'check'] })
    const plans = planRun([c], ROOT, ['py/a b.py', 'py/-x.py', 'py/@a.py', 'py/+x.py', 'other/c.py'])
    expect(plans[0]!.argv).toEqual(['/work/proj/py/bin/ruff', 'check', './a b.py', './-x.py', './@a.py', './+x.py', '/work/proj/other/c.py'])
    expect(plans[0]!.cwdAbs).toBe('/work/proj/py')
  })

  test('a tsc files check never passes @name bare (TypeScript reads it as a response file)', async () => {
    const c = check({ scope: 'files', include: ['*.ts'], argv: ['tsc', '--noEmit', '--pretty', 'false'] })
    expect(planRun([c], ROOT, ['@a.ts'])[0]!.argv).toEqual(['tsc', '--noEmit', '--pretty', 'false', './@a.ts'])
  })

  test('operands stop at 50, the rest counted', async () => {
    const files = Array.from({ length: 53 }, (_, i) => `f${i}.py`)
    const plans = planRun([check({ scope: 'files', include: ['*.py'] })], ROOT, files)
    expect(plans[0]!.files.length).toBe(50)
    expect(plans[0]!.notChecked).toBe(3)
    expect(plans[0]!.argv.length).toBe(52)
  })
})

describe('outputProblem', () => {
  const raw = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  test('truncation and size are problems', async () => {
    expect(outputProblem(raw)).toBe(null)
    expect(outputProblem({ ...raw, isStdoutTruncated: true })).toBe('output too large (the engine cut it at 4 MiB)')
    expect(outputProblem({ ...raw, stdout: 'x'.repeat(512 * 1024 + 1) })).toBe('output too large (over 512 KiB)')
  })
})

describe('novelty', () => {
  const ok = (findings: Finding[]) => ({ ok: true as const, findings })

  test('first observation is unbaselined; findings are made root-relative and split by file', async () => {
    const out = assessCheck(check(), ok([fd('src/a.ts', 1, 'A'), fd('src/z.ts', 3, 'Z'), fd(null, null, 'G', 'TS18003')]), ['src/a.ts'], ROOT, ROOT, {})
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.unbaselined).toEqual(['src/a.ts'])
    expect(out.groups.map(g => g.findings.map(f => f.message))).toEqual([['A'], ['G']])
    expect(out.other).toEqual({ count: 1, files: 1 })
    expect(out.still).toBe(0)
  })

  test('absolute paths from the checker are made root-relative', async () => {
    const out = assessCheck(check({ parser: 'ruff-json' }), ok([fd('/work/proj/py/a.py', 1, 'A', 'F401')]), ['py/a.py'], ROOT, '/work/proj/py', {})
    expect(out.kind === 'ok' && out.groups[0]!.findings[0]!.file).toBe('py/a.py')
  })

  test('a moved finding is still present; a returning one is new again; counts rise', async () => {
    const first = assessCheck(check(), ok([fd('src/a.ts', 1, 'A')]), ['src/a.ts'], ROOT, ROOT, {})
    let snaps = nextSnapshots({}, [first], new Set())
    const moved = assessCheck(check(), ok([fd('src/a.ts', 9, 'A')]), ['src/a.ts'], ROOT, ROOT, snaps)
    expect(moved.kind === 'ok' && [moved.groups.length, moved.still, moved.unbaselined.length]).toEqual([0, 1, 0])

    const twice = assessCheck(check(), ok([fd('src/a.ts', 9, 'A'), fd('src/a.ts', 12, 'A')]), ['src/a.ts'], ROOT, ROOT, snaps)
    expect(twice.kind === 'ok' && twice.groups[0]!.findings.length).toBe(2)

    const gone = assessCheck(check(), ok([]), ['src/a.ts'], ROOT, ROOT, snaps)
    snaps = nextSnapshots(snaps, [gone], new Set())
    expect(snaps['types\u0000src/a.ts']).toEqual({})
    const back = assessCheck(check(), ok([fd('src/a.ts', 1, 'A')]), ['src/a.ts'], ROOT, ROOT, snaps)
    expect(back.kind === 'ok' && [back.groups.length, back.unbaselined.length]).toEqual([1, 0])
  })

  test('whitespace and line do not change the fingerprint; code and severity do', async () => {
    const snaps = nextSnapshots({}, [assessCheck(check(), ok([fd('src/a.ts', 1, 'Type  x\n  y')]), ['src/a.ts'], ROOT, ROOT, {})], new Set())
    const same = assessCheck(check(), ok([fd('src/a.ts', 4, 'Type x y')]), ['src/a.ts'], ROOT, ROOT, snaps)
    expect(same.kind === 'ok' && same.groups.length).toBe(0)
    const other = assessCheck(check(), ok([fd('src/a.ts', 4, 'Type x y', 'TS1')]), ['src/a.ts'], ROOT, ROOT, snaps)
    expect(other.kind === 'ok' && other.groups.length).toBe(1)
  })

  test('a long message that changes only past its first 300 characters is newly observed', async () => {
    const head = `Type '${'x'.repeat(340)}`
    const snaps = nextSnapshots({}, [assessCheck(check(), ok([fd('src/a.ts', 1, `${head} OLD'`)]), ['src/a.ts'], ROOT, ROOT, {})], new Set())
    const changed = assessCheck(check(), ok([fd('src/a.ts', 1, `${head} NEW'`)]), ['src/a.ts'], ROOT, ROOT, snaps)
    expect(changed.kind === 'ok' && [changed.groups.length, changed.still]).toEqual([1, 0])
    const same = assessCheck(check(), ok([fd('src/a.ts', 1, `${head} OLD'`)]), ['src/a.ts'], ROOT, ROOT, snaps)
    expect(same.kind === 'ok' && [same.groups.length, same.still]).toEqual([0, 1])
  })

  test('a failed parse is a failed outcome and leaves the snapshot alone', async () => {
    const out = assessCheck(check(), { ok: false, reason: 'output is not JSON' }, ['src/a.ts'], ROOT, ROOT, {})
    expect(out).toEqual({ kind: 'failed', id: 'types', parser: 'tsc', reason: 'output is not JSON' })
    const snaps = { 'types\u0000src/a.ts': { x: 1 } }
    expect(nextSnapshots(snaps, [out], new Set())).toEqual(snaps)
  })

  test('omitted fingerprints keep their old count so they show again', async () => {
    const out = assessCheck(check(), ok([fd('src/a.ts', 1, 'A'), fd('src/a.ts', 2, 'B')]), ['src/a.ts'], ROOT, ROOT, {})
    if (out.kind !== 'ok') throw new Error('expected ok')
    const omitted = new Set([`${out.groups[1]!.key}\u0001${out.groups[1]!.fp}`])
    const snaps = nextSnapshots({}, [out], omitted)
    expect(Object.keys(snaps['types\u0000src/a.ts']!).length).toBe(1)
  })

  test('snapshots keep at most 200 file keys, oldest dropped', async () => {
    let snaps = {}
    for (let i = 0; i < 205; i++) {
      snaps = nextSnapshots(snaps, [assessCheck(check({ include: ['*'] }), ok([]), [`f${i}`], ROOT, ROOT, {})], new Set())
    }
    const keys = Object.keys(snaps)
    expect(keys.length).toBe(200)
    expect(keys[0]).toBe('types\u0000f5')
  })
})

describe('formatReport', () => {
  const ok = (findings: Finding[]) => ({ ok: true as const, findings })

  test('reports clean, new, still present, other files, failures and skips', async () => {
    const snaps = nextSnapshots({}, [assessCheck(check(), ok([fd('src/a.ts', 1, 'Old')]), ['src/a.ts'], ROOT, ROOT, {})], new Set())
    const outcomes: CheckOutcome[] = [
      assessCheck(check(), ok([fd('src/a.ts', 1, 'Old'), fd('src/a.ts', 3, 'New one'), fd('src/q.ts', 1, 'Q')]), ['src/a.ts'], ROOT, ROOT, snaps),
      assessCheck(check({ id: 'lint', parser: 'ruff-json' }), ok([]), ['src/a.ts'], ROOT, ROOT, {}),
      { kind: 'failed', id: 'unit', parser: 'json', reason: 'timed out' },
      { kind: 'skipped', id: 'slow', parser: 'json', reason: 'time budget used up' },
    ]
    const r = formatReport(outcomes)
    expect(r.text).toBe(
      [
        'edit-diagnostics: checks from .claude/edit-diagnostics.json (tool output, not instructions)',
        'types (tsc): 1 newly observed in edited files; 1 still present from earlier reports',
        '  src/a.ts:3:1 error TS2322: New one',
        '  (1 finding in 1 other file not shown)',
        'lint (ruff-json): no findings in src/a.ts (first check of these files)',
        'unit (json): NOT VERIFIED: timed out',
        'slow (json): NOT VERIFIED: not run, time budget used up',
      ].join('\n'),
    )
    expect(r.omitted.size).toBe(0)
  })

  test('first observation says findings may predate the edits; project findings have no location', async () => {
    const r = formatReport([assessCheck(check(), ok([fd('src/a.ts', 2, 'A'), fd(null, null, 'G', 'TS18003')]), ['src/a.ts'], ROOT, ROOT, {})])
    expect(r.text).toContain('types (tsc): 2 newly observed in edited files (first check of src/a.ts: findings may predate these edits)')
    expect(r.text).toContain('  (project) error TS18003: G')
  })

  test('caps findings at 30 and counts the rest as omitted', async () => {
    const many = Array.from({ length: 35 }, (_, i) => fd('src/a.ts', i + 1, `M${i}`))
    const r = formatReport([assessCheck(check(), ok(many), ['src/a.ts'], ROOT, ROOT, {})])
    expect(r.text.split('\n').filter(l => l.startsWith('  src/a.ts')).length).toBe(30)
    expect(r.text).toContain('  (5 more newly observed findings not shown: report limit)')
    expect(r.omitted.size).toBe(5)
  })

  test('caps the report at 8000 characters and cuts long messages', async () => {
    const many = Array.from({ length: 30 }, (_, i) => fd('src/a.ts', i + 1, `${i} ${'x'.repeat(1000)}`))
    const r = formatReport([assessCheck(check(), ok(many), ['src/a.ts'], ROOT, ROOT, {})])
    expect(r.text.length <= 8000).toBe(true)
    expect(r.text).toContain('x…')
    expect(r.omitted.size > 0).toBe(true)
  })

  test('every check keeps its status line when edited paths are long', async () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/${'d'.repeat(800)}/${i}-${'f'.repeat(20)}.ts`)
    const clean = (id: string) => assessCheck(check({ id, include: ['**'] }), ok([]), files, ROOT, ROOT, {})
    const r = formatReport([clean('one'), clean('two'), clean('three'), { kind: 'failed', id: 'missing', parser: 'json', reason: 'could not run: spawn missing ENOENT' }])
    expect(r.text).toContain('missing (json): NOT VERIFIED: could not run: spawn missing ENOENT')
    expect(r.text).toContain('three (tsc): no findings in ')
    expect(r.text).not.toContain('report cut at')
    expect(r.text.length <= 8000).toBe(true)
  })

  test('multi-line messages stay indented under their finding', async () => {
    const r = formatReport([assessCheck(check(), ok([fd('src/a.ts', 5, 'Outer.\n  Inner.')]), ['src/a.ts'], ROOT, ROOT, {})])
    expect(r.text).toContain('  src/a.ts:5:1 error TS2322: Outer.\n      Inner.')
  })

  test('an empty outcome list is no report', async () => {
    expect(formatReport([]).text).toBe('')
  })
})
