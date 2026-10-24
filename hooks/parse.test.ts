// The standing parser corpus. Outputs were captured on Claude Code's host
// (TypeScript 5.9.3 `tsc --noEmit --pretty false`, ruff 0.17.2
// `ruff check --output-format json`); absolute paths were replaced with
// /work/proj. Every parser bug reported becomes a row here.
import { describe, expect, test } from 'claude-code/testing'

import { parseOutput } from './parse'
import type { Finding, ParserName, ParseResult } from '../types'

type Row = {
  name: string
  parser: ParserName
  exitCode: number
  stdout: string
  stderr?: string
  expected: ParseResult
}

const f = (file: string | null, line: number | null, col: number | null, severity: Finding['severity'], code: string | null, message: string): Finding => ({
  file,
  line,
  col,
  severity,
  code,
  message,
})
const ok = (...findings: Finding[]): ParseResult => ({ ok: true, findings })
const fail = (reason: string): ParseResult => ({ ok: false, reason })

// Real: a project with type errors, a two-line message, Unicode and a file name with a space and parentheses.
const TSC_ERRORS = `src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/a.ts(3,29): error TS2322: Type 'string' is not assignable to type 'number'.
src/a.ts(5,3): error TS2345: Argument of type '{ name: string; }' is not assignable to parameter of type '{ name: string; age: number; }'.
  Property 'age' is missing in type '{ name: string; }' but required in type '{ name: string; age: number; }'.
src/a.ts(7,25): error TS2307: Cannot find module './nope' or its corresponding type declarations.
src/b.ts(1,5): error TS2322: Type 'number' is not assignable to type 'string'.
src/we ird(1).ts(1,7): error TS2322: Type '"ö"' is not assignable to type '"ä☃"'.
src/we ird(1).ts(3,26): error TS2322: Type 'boolean' is not assignable to type 'number'.
`
const TSC_ERRORS_EXPECTED = ok(
  f('src/a.ts', 1, 7, 'error', 'TS2322', "Type 'string' is not assignable to type 'number'."),
  f('src/a.ts', 3, 29, 'error', 'TS2322', "Type 'string' is not assignable to type 'number'."),
  f(
    'src/a.ts',
    5,
    3,
    'error',
    'TS2345',
    "Argument of type '{ name: string; }' is not assignable to parameter of type '{ name: string; age: number; }'.\n  Property 'age' is missing in type '{ name: string; }' but required in type '{ name: string; age: number; }'.",
  ),
  f('src/a.ts', 7, 25, 'error', 'TS2307', "Cannot find module './nope' or its corresponding type declarations."),
  f('src/b.ts', 1, 5, 'error', 'TS2322', "Type 'number' is not assignable to type 'string'."),
  f('src/we ird(1).ts', 1, 7, 'error', 'TS2322', `Type '"ö"' is not assignable to type '"ä☃"'.`),
  f('src/we ird(1).ts', 3, 26, 'error', 'TS2322', "Type 'boolean' is not assignable to type 'number'."),
)

// Real: a config error with no file (global) and one located in tsconfig.json.
const TSC_GLOBAL = `error TS18003: No inputs were found in config file '/work/proj/tsconfig.json'. Specified 'include' paths were '["nothing"]' and 'exclude' paths were '[]'.
tsconfig.json(1,24): error TS5023: Unknown compiler option 'bogusOption'.
`

// Real: ruff with a syntax error (code "invalid-syntax") and a fixable lint, trimmed of fields the parser ignores.
const RUFF_ERRORS = JSON.stringify([
  {
    cell: null,
    code: 'invalid-syntax',
    end_location: { column: 8, row: 3 },
    filename: '/work/proj/bad.py',
    fix: null,
    location: { column: 7, row: 3 },
    message: 'Expected a parameter or the end of the parameter list',
    name: 'invalid-syntax',
    noqa_row: null,
    severity: 'error',
    url: null,
  },
  {
    cell: null,
    code: 'F401',
    end_location: { column: 11, row: 1 },
    filename: '/work/proj/lint.py',
    fix: { applicability: 'safe', edits: [], message: 'Remove unused import: `sys`' },
    location: { column: 8, row: 1 },
    message: '`sys` imported but unused',
    name: 'unused-import',
    noqa_row: 1,
    severity: 'error',
    url: 'https://docs.astral.sh/ruff/rules/unused-import',
  },
], null, 2)

const NORMALIZED = JSON.stringify({
  version: 1,
  findings: [
    { file: 'src/x.ts', line: 2, col: 1, severity: 'warning', code: 'no-unused-vars', message: "'é' is defined but never used." },
    { file: null, line: null, col: null, severity: 'error', code: null, message: 'Parsing error: config not found' },
  ],
})

const CORPUS: Row[] = [
  // tsc
  { name: 'tsc: real errors, multi-line, Unicode, odd file name', parser: 'tsc', exitCode: 2, stdout: TSC_ERRORS, expected: TSC_ERRORS_EXPECTED },
  { name: 'tsc: the same output with CRLF line ends', parser: 'tsc', exitCode: 2, stdout: TSC_ERRORS.replace(/\n/g, '\r\n'), expected: TSC_ERRORS_EXPECTED },
  {
    name: 'tsc: global and config diagnostics',
    parser: 'tsc',
    exitCode: 2,
    stdout: TSC_GLOBAL,
    expected: ok(
      f(null, null, null, 'error', 'TS18003', `No inputs were found in config file '/work/proj/tsconfig.json'. Specified 'include' paths were '["nothing"]' and 'exclude' paths were '[]'.`),
      f('tsconfig.json', 1, 24, 'error', 'TS5023', "Unknown compiler option 'bogusOption'."),
    ),
  },
  { name: 'tsc: clean run prints nothing and exits 0', parser: 'tsc', exitCode: 0, stdout: '', expected: ok() },
  {
    name: 'tsc: diagnostic-looking text inside a message stays in the message',
    parser: 'tsc',
    exitCode: 2,
    stdout: "src/m.ts(2,1): error TS2322: Type '\"x.ts(9,9): error TS1: no\"' is not assignable to type 'number'.\n",
    expected: ok(f('src/m.ts', 2, 1, 'error', 'TS2322', "Type '\"x.ts(9,9): error TS1: no\"' is not assignable to type 'number'.")),
  },
  {
    name: 'tsc: an indented header-looking line is a continuation',
    parser: 'tsc',
    exitCode: 2,
    stdout: "src/m.ts(2,1): error TS2322: Outer.\n  src/n.ts(3,3): error TS2322: inner text\n",
    expected: ok(f('src/m.ts', 2, 1, 'error', 'TS2322', 'Outer.\n  src/n.ts(3,3): error TS2322: inner text')),
  },
  { name: 'tsc: nonzero exit with no findings is not verified', parser: 'tsc', exitCode: 1, stdout: '', stderr: 'Killed', expected: fail('exit code 1 with no findings (stderr: Killed)') },
  { name: 'tsc: an unexpected exit code is not verified', parser: 'tsc', exitCode: 3, stdout: TSC_ERRORS, expected: fail('unexpected exit code 3') },
  { name: 'tsc: a line it does not recognize is not verified', parser: 'tsc', exitCode: 2, stdout: 'Version 5.9.3\n', expected: fail("unrecognized tsc output at line 1: 'Version 5.9.3'") },
  { name: 'tsc: a continuation with no header is not verified', parser: 'tsc', exitCode: 2, stdout: '  stray\n', expected: fail("unrecognized tsc output at line 1: '  stray'") },
  { name: 'tsc: pretty output is not verified', parser: 'tsc', exitCode: 2, stdout: "src/a.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.\n", expected: fail("unrecognized tsc output at line 1: 'src/a.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.'") },

  // ruff-json
  {
    name: 'ruff: real syntax error and lint',
    parser: 'ruff-json',
    exitCode: 1,
    stdout: RUFF_ERRORS,
    expected: ok(
      f('/work/proj/bad.py', 3, 7, 'error', 'invalid-syntax', 'Expected a parameter or the end of the parameter list'),
      f('/work/proj/lint.py', 1, 8, 'error', 'F401', '`sys` imported but unused'),
    ),
  },
  { name: 'ruff: real empty report', parser: 'ruff-json', exitCode: 0, stdout: '[]', expected: ok() },
  { name: 'ruff: CRLF and Unicode', parser: 'ruff-json', exitCode: 1, stdout: '[\r\n{"code":"E501","filename":"/work/proj/é.py","location":{"row":1,"column":89},"message":"Line too long (90 > 88) ☃"}\r\n]\r\n', expected: ok(f('/work/proj/é.py', 1, 89, 'error', 'E501', 'Line too long (90 > 88) ☃')) },
  { name: 'ruff: null code and null location', parser: 'ruff-json', exitCode: 1, stdout: '[{"code":null,"filename":"/work/proj/a.py","location":null,"message":"odd"}]', expected: ok(f('/work/proj/a.py', null, null, 'error', null, 'odd')) },
  { name: 'ruff: real error exit with nothing on stdout', parser: 'ruff-json', exitCode: 2, stdout: '', stderr: 'ruff failed\n  Cause: Unknown rule selector `BOGUS` in `select` from the CLI\n', expected: fail('unexpected exit code 2 (stderr: ruff failed / Cause: Unknown rule selector `BOGUS` in `select` from the CLI)') },
  { name: 'ruff: exit 1 with an empty report is not verified', parser: 'ruff-json', exitCode: 1, stdout: '[]', expected: fail('exit code 1 with no findings') },
  { name: 'ruff: malformed JSON', parser: 'ruff-json', exitCode: 1, stdout: '[{"code":', expected: fail('output is not JSON') },
  { name: 'ruff: empty output', parser: 'ruff-json', exitCode: 0, stdout: '', expected: fail('no output') },
  { name: 'ruff: not an array', parser: 'ruff-json', exitCode: 0, stdout: '{}', expected: fail('expected a JSON array') },
  { name: 'ruff: a finding missing its message', parser: 'ruff-json', exitCode: 1, stdout: '[{"code":"F401","filename":"a.py","location":{"row":1,"column":1}}]', expected: fail('finding 1: message must be a string') },
  { name: 'ruff: a bad location', parser: 'ruff-json', exitCode: 1, stdout: '[{"code":"F401","filename":"a.py","location":{"row":0,"column":1},"message":"m"}]', expected: fail('finding 1: location must be null or { row, column } of whole numbers from 1') },
  { name: 'ruff: an unknown severity', parser: 'ruff-json', exitCode: 1, stdout: '[{"code":"F401","filename":"a.py","location":{"row":1,"column":1},"message":"m","severity":"fatal"}]', expected: fail('finding 1: severity must be error, warning or info') },

  // json (normalized)
  {
    name: 'json: findings with a project-level one',
    parser: 'json',
    exitCode: 1,
    stdout: NORMALIZED,
    expected: ok(
      f('src/x.ts', 2, 1, 'warning', 'no-unused-vars', "'é' is defined but never used."),
      f(null, null, null, 'error', null, 'Parsing error: config not found'),
    ),
  },
  { name: 'json: empty valid report', parser: 'json', exitCode: 0, stdout: '{"version":1,"findings":[]}\r\n', expected: ok() },
  { name: 'json: wrong version', parser: 'json', exitCode: 0, stdout: '{"version":2,"findings":[]}', expected: fail('version must be 1') },
  { name: 'json: an unknown top-level key', parser: 'json', exitCode: 0, stdout: '{"version":1,"findings":[],"extra":1}', expected: fail('unknown key: extra') },
  { name: 'json: an unknown finding key', parser: 'json', exitCode: 1, stdout: '{"version":1,"findings":[{"file":null,"line":null,"col":null,"severity":"error","code":null,"message":"m","x":1}]}', expected: fail('finding 1: unknown key: x') },
  { name: 'json: a missing field', parser: 'json', exitCode: 1, stdout: '{"version":1,"findings":[{"file":null,"line":null,"col":null,"severity":"error","message":"m"}]}', expected: fail('finding 1: code must be a string or null') },
  { name: 'json: a fractional line', parser: 'json', exitCode: 1, stdout: '{"version":1,"findings":[{"file":"a","line":1.5,"col":null,"severity":"error","code":null,"message":"m"}]}', expected: fail('finding 1: line must be a whole number from 1, or null') },
  { name: 'json: an empty message', parser: 'json', exitCode: 1, stdout: '{"version":1,"findings":[{"file":"a","line":1,"col":1,"severity":"error","code":null,"message":" "}]}', expected: fail('finding 1: message must be a nonempty string') },
  { name: 'json: exit 1 with no findings', parser: 'json', exitCode: 1, stdout: '{"version":1,"findings":[]}', expected: fail('exit code 1 with no findings') },
  { name: 'json: unexpected exit', parser: 'json', exitCode: 127, stdout: '', stderr: 'wrapper: not found', expected: fail('unexpected exit code 127 (stderr: wrapper: not found)') },
  { name: 'json: an empty file name', parser: 'json', exitCode: 1, stdout: '{"version":1,"findings":[{"file":"","line":null,"col":null,"severity":"error","code":null,"message":"m"}]}', expected: fail('finding 1: file must be a nonempty string or null') },
  { name: 'json: a proto key is just an unknown key', parser: 'json', exitCode: 0, stdout: '{"version":1,"findings":[],"__proto__":{"x":1}}', expected: fail('unknown key: __proto__') },
]

describe('parser corpus', () => {
  for (const row of CORPUS) {
    test(row.name, async () => {
      expect(parseOutput(row.parser, { exitCode: row.exitCode, stdout: row.stdout, stderr: row.stderr ?? '' })).toEqual(row.expected)
    })
  }
})
