export type Mode = 'on' | 'off'
export type Delivery = 'tool' | 'batch'
export type ParserName = 'tsc' | 'ruff-json' | 'json'
export type Severity = 'error' | 'warning' | 'info'

/** The options in plugin.json's userConfig, parsed with defaults filled in and limits applied. */
export type Config = {
  enabled: boolean
  delivery: Delivery
  /** Longest one check may run, ms. */
  timeoutMs: number
  /** Total time all checks of one run may take, ms. */
  batchTimeoutMs: number
}

/** One check from `.claude/edit-diagnostics.json`, validated. */
export type Check = {
  id: string
  argv: string[]
  /** Root-relative, folded, never escaping the root; `.` for the root. */
  cwd: string
  include: string[]
  scope: 'files' | 'project'
  parser: ParserName
}

export type ChecksFile = { version: 1; checks: Check[] }

/** A finding as a parser reads it; `file` as printed (relative to the check's cwd, or absolute). */
export type Finding = {
  file: string | null
  /** 1-based; null for a project-level finding or one with no position. */
  line: number | null
  col: number | null
  severity: Severity
  code: string | null
  message: string
}

/** A parser's answer: every finding, or why the output can't be trusted. */
export type ParseResult = { ok: true; findings: Finding[] } | { ok: false; reason: string }

/** The claim on the one run allowed at a time. */
export type Running = {
  runId: string
  /** The module load that owns the run; another load's claim is stale. */
  loadId: string
  /** Root-relative paths the run took from `pending`. */
  paths: string[]
}

/** Fingerprint counts per `<check id>\u0000<root-relative file, or empty for project-level>`. */
export type Snapshots = Record<string, Record<string, number>>

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /edit-diagnostics on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
  /** Root-relative paths edited and not yet covered by a completed run, oldest first. */
  pending: string[]
  running: Running | null
  snapshots: Snapshots
  /** One line per check of the last run, for /edit-diagnostics status. */
  lastRun: string[]
  /** Keys of notices already given (config not approved, batch hook skipped), so each is said once. */
  notices: string[]
  /** Successful main-loop mutations seen, and runs of the batch hook. */
  mutations: number
  batchRuns: number
}

declare module 'claude-code' {
  interface PluginState {
    'edit-diagnostics': { session: Shaped<Session> }
  }
}
