// Output parsers, one per format. Pure and strict: whatever a parser doesn't
// recognize makes the whole output untrusted (`{ ok: false }`), never a
// skipped line. The standing corpus in parse.test.ts pins each one.
import type { Finding, ParserName, ParseResult, Severity } from '../types'

export type RawOutput = { exitCode: number; stdout: string; stderr: string }

/** Exit codes each parser accepts; any other is "not verified". */
const ACCEPTED: Record<ParserName, readonly number[]> = {
  tsc: [0, 1, 2],
  'ruff-json': [0, 1],
  json: [0, 1],
}

/** Up to 200 characters of stderr's nonblank lines, joined, for a reason. */
export function stderrExcerpt(stderr: string): string {
  const text = stderr
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== '')
    .join(' / ')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function withStderr(reason: string, stderr: string): string {
  const ex = stderrExcerpt(stderr)
  return ex === '' ? reason : `${reason} (stderr: ${ex})`
}

export function parseOutput(parser: ParserName, out: RawOutput): ParseResult {
  if (!ACCEPTED[parser].includes(out.exitCode)) return { ok: false, reason: withStderr(`unexpected exit code ${out.exitCode}`, out.stderr) }
  const parsed = parser === 'tsc' ? parseTsc(out.stdout) : parser === 'ruff-json' ? parseRuff(out.stdout) : parseNormalized(out.stdout)
  if (!parsed.ok) return parsed
  if (out.exitCode !== 0 && parsed.findings.length === 0) return { ok: false, reason: withStderr(`exit code ${out.exitCode} with no findings`, out.stderr) }
  return parsed
}

const TSC_LOCATED = /^(\S.*?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/
const TSC_GLOBAL = /^(error|warning|message) (TS\d+): (.*)$/
const TSC_SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning', message: 'info' }

function quoteLine(line: string): string {
  return `'${line.length > 120 ? `${line.slice(0, 120)}…` : line}'`
}

/** `tsc --pretty false`: one header line per diagnostic, its chain indented below it. */
export function parseTsc(stdout: string): ParseResult {
  const findings: Finding[] = []
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  let current: Finding | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s+$/, '')
    if (line === '') {
      current = null
      continue
    }
    if (line.startsWith('  ') && current !== null) {
      current.message += `\n${line}`
      continue
    }
    const located = TSC_LOCATED.exec(line)
    if (located !== null) {
      current = {
        file: located[1]!,
        line: Number(located[2]),
        col: Number(located[3]),
        severity: TSC_SEVERITY[located[4]!]!,
        code: located[5]!,
        message: located[6]!,
      }
      findings.push(current)
      continue
    }
    const global = TSC_GLOBAL.exec(line)
    if (global !== null) {
      current = { file: null, line: null, col: null, severity: TSC_SEVERITY[global[1]!]!, code: global[2]!, message: global[3]! }
      findings.push(current)
      continue
    }
    return { ok: false, reason: `unrecognized tsc output at line ${i + 1}: ${quoteLine(line)}` }
  }
  return { ok: true, findings }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1
}

function parseJson(stdout: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const text = stdout.trim()
  if (text === '') return { ok: false, reason: 'no output' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'output is not JSON' }
  }
}

function severityOf(v: unknown): Severity | null {
  return v === 'error' || v === 'warning' || v === 'info' ? v : null
}

/** `ruff check --output-format json`: an array of violations. */
export function parseRuff(stdout: string): ParseResult {
  const json = parseJson(stdout)
  if (!json.ok) return json
  if (!Array.isArray(json.value)) return { ok: false, reason: 'expected a JSON array' }
  const findings: Finding[] = []
  for (let i = 0; i < json.value.length; i++) {
    const item: unknown = json.value[i]
    const at = `finding ${i + 1}`
    if (!isRecord(item)) return { ok: false, reason: `${at}: not an object` }
    const code = item['code']
    if (code !== null && typeof code !== 'string') return { ok: false, reason: `${at}: code must be a string or null` }
    const filename = item['filename']
    if (typeof filename !== 'string' || filename === '') return { ok: false, reason: `${at}: filename must be a nonempty string` }
    const loc = item['location']
    let line: number | null = null
    let col: number | null = null
    if (loc !== null) {
      if (!isRecord(loc) || !isPosInt(loc['row']) || !isPosInt(loc['column'])) {
        return { ok: false, reason: `${at}: location must be null or { row, column } of whole numbers from 1` }
      }
      line = loc['row']
      col = loc['column']
    }
    const message = item['message']
    if (typeof message !== 'string') return { ok: false, reason: `${at}: message must be a string` }
    let severity: Severity = 'error'
    if (Object.hasOwn(item, 'severity')) {
      const s = severityOf(item['severity'])
      if (s === null) return { ok: false, reason: `${at}: severity must be error, warning or info` }
      severity = s
    }
    findings.push({ file: filename, line, col, severity, code, message })
  }
  return { ok: true, findings }
}

const TOP_KEYS = ['version', 'findings']
const FINDING_KEYS = ['file', 'line', 'col', 'severity', 'code', 'message']

/** The mod's own format: `{ "version": 1, "findings": [Finding] }`, strict. */
export function parseNormalized(stdout: string): ParseResult {
  const json = parseJson(stdout)
  if (!json.ok) return json
  const top = json.value
  if (!isRecord(top)) return { ok: false, reason: 'expected a JSON object' }
  const extra = Object.keys(top).find(k => !TOP_KEYS.includes(k))
  if (extra !== undefined) return { ok: false, reason: `unknown key: ${extra}` }
  if (top['version'] !== 1) return { ok: false, reason: 'version must be 1' }
  const list = top['findings']
  if (!Array.isArray(list)) return { ok: false, reason: 'findings must be an array' }
  const findings: Finding[] = []
  for (let i = 0; i < list.length; i++) {
    const item: unknown = list[i]
    const at = `finding ${i + 1}`
    if (!isRecord(item)) return { ok: false, reason: `${at}: not an object` }
    const unknownKey = Object.keys(item).find(k => !FINDING_KEYS.includes(k))
    if (unknownKey !== undefined) return { ok: false, reason: `${at}: unknown key: ${unknownKey}` }
    const file = item['file']
    if (file !== null && (typeof file !== 'string' || file === '')) return { ok: false, reason: `${at}: file must be a nonempty string or null` }
    const line = item['line']
    if (line !== null && !isPosInt(line)) return { ok: false, reason: `${at}: line must be a whole number from 1, or null` }
    const col = item['col']
    if (col !== null && !isPosInt(col)) return { ok: false, reason: `${at}: col must be a whole number from 1, or null` }
    const severity = severityOf(item['severity'])
    if (severity === null) return { ok: false, reason: `${at}: severity must be error, warning or info` }
    const code = item['code']
    if (code !== null && typeof code !== 'string') return { ok: false, reason: `${at}: code must be a string or null` }
    const message = item['message']
    if (typeof message !== 'string' || message.trim() === '') return { ok: false, reason: `${at}: message must be a nonempty string` }
    findings.push({ file, line, col, severity, code, message })
  }
  return { ok: true, findings }
}
