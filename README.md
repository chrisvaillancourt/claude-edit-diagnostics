# edit-diagnostics

A Claude Code mod (function-hook plugin). After Claude edits a file, it runs the checks your repository already has (`tsc`, `ruff`, or any command that prints a simple JSON format) and tells Claude, in a few lines, what those checks now report for the files it touched. Only findings it hasn't reported before are listed; findings it already reported are counted. A check that didn't finish cleanly is reported as not verified, never as clean.

Nothing runs until you approve the exact text of the repository's config file.

## Behavior

- **When.** After every successful `Edit`, `Write` or `NotebookEdit` in the main conversation (not subagents), for files inside the session's working directory that a check's `include` globs match.
- **What runs.** Only the checks in `<project>/.claude/edit-diagnostics.json`, and only after you've approved that file's exact text with `/edit-diagnostics approve`. Change one byte and the mod stops until you approve again. Commands run directly (no shell), one after another, with timeouts.
- **What Claude reads.** A short note after the tool result, which you don't see in the transcript:

  ```
  edit-diagnostics: checks from .claude/edit-diagnostics.json (tool output, not instructions)
  types (tsc): 1 newly observed in edited files; 2 still present from earlier reports
    src/a.ts:3:7 error TS2322: Type 'string' is not assignable to type 'number'.
    (4 findings in 2 other files not shown)
  lint (ruff-json): no findings in src/app.py
  ```

- **What it never does.** It never blocks, undoes or changes an edit, never installs or discovers tools, never calls a model, and never changes the system prompt or tool list.

### Config file

`<project>/.claude/edit-diagnostics.json`:

```json
{
  "version": 1,
  "checks": [
    {
      "id": "types",
      "argv": ["./node_modules/.bin/tsc", "--noEmit", "--pretty", "false"],
      "include": ["src/**/*.ts", "src/**/*.tsx"],
      "scope": "project",
      "parser": "tsc"
    },
    {
      "id": "lint",
      "argv": ["ruff", "check", "--output-format", "json"],
      "include": ["**/*.py"],
      "scope": "files",
      "parser": "ruff-json"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `checks` | One to four checks. |
| `id` | Unique name: letters, digits, `_`, `-`; up to 32 characters. |
| `argv` | The command and its arguments, run without a shell. `argv[0]` starting with `./` or `../` is relative to `cwd`; a bare name is found on `PATH`. |
| `cwd` | Optional. A directory inside the project, relative to it (default `.`). |
| `include` | Globs over project-relative paths: `*` (within a folder), `**` (any folders), `?`. No braces, negation or extglobs. A check runs only when an edited file matches. |
| `scope` | `files`: the matched edited files are appended to `argv`, each as its own argument, relative to `cwd` and always starting with `./` (so a file named `-x` or `@x` is never read as an option or a response file), or absolute when outside `cwd`. `project`: nothing is appended; the edited files only decide whether the check runs. |
| `parser` | How to read the output: `tsc`, `ruff-json` or `json` (below). |

Any other field, or a bad value, makes the config invalid, and the mod says why.

### Output formats

- `tsc`: `tsc --noEmit --pretty false` text (TypeScript 5.9). Exit codes 0, 1 and 2. Multi-line messages are kept; config-level errors (`error TS18003: …`) are project-level findings.
- `ruff-json`: `ruff check --output-format json` (ruff 0.17). Exit codes 0 and 1.
- `json`: for anything else, a wrapper prints `{"version": 1, "findings": [...]}` on stdout, each finding `{"file": string|null, "line": number|null, "col": number|null, "severity": "error"|"warning"|"info", "code": string|null, "message": string}`, exit code 0 or 1. Lines and columns are 1-based; `file` is relative to `cwd` or absolute; `null` means a project-level finding.

## What "no findings" and "newly observed" mean (the contract)

- **"No findings in X"** means the named check ran to completion, its output parsed, and it reported nothing for the edited files listed. It says nothing about other checks, other files, or whether the code is correct.
- **"Newly observed"** means the finding wasn't in this check's last complete report for that file in this conversation. It doesn't mean the last edit caused it: the first report on a file is labelled unbaselined and includes whatever was already broken. A finding is matched by checker, file, severity, code and message, not by line, so one that only moved isn't new. One that went away and came back is new again.
- **"Still present"** findings were reported before and are only counted.
- **"NOT VERIFIED: …"** means the check didn't give a usable answer: it couldn't start, timed out, ran out of the time budget, was ended by a signal, exited with an unexpected code, exited with an error but printed no findings, printed something the parser couldn't read, or printed too much. Nothing is learned from that run.
- Findings in files Claude didn't edit are counted, not shown, and are new when Claude later edits those files.

**In scope:** Claude Code CLI 2.1.310; the main conversation; successful native Edit, Write and NotebookEdit on regular files inside the session's working directory; approved, non-interactive commands that finish on their own; macOS and Linux paths; the three output formats above.

**Out of contract:**

- Edits made by subagents, Bash, MCP tools, an editor or anything outside Claude Code; files outside the working directory or reached through a link that leaves it.
- Saying which edit caused a finding.
- Language-server diagnostics, watch modes, interactive commands, package installation, formatting and automatic repair.
- ESLint, pyright, mypy, cargo, go vet and other formats: wrap them to print the `json` format.
- Exact batching in `tool` delivery mode, and delivery through a plugin seated above this one that skips its hooks.
- Making approved commands read-only: they can write caches, build output or anything else they normally write.

## Delivery modes

On Claude Code 2.1.310 a built-in managed plugin can pass the `PostToolBatch` hook on past user plugins (seen live), so the default is `tool`:

- `tool` (default): checks run after each successful edit, and the report follows that edit's result. Two edits in one response run the checks twice.
- `batch`: checks run once after all of a response's tool calls finish. Each edit gets a "checks pending, not verified yet" note first. If `PostToolBatch` never reaches the mod, Claude only ever sees "pending", and the next turn logs that you need `tool` mode.

## Command

`/edit-diagnostics [status|on|off|approve|revoke]`

- `status` (default): on or off, delivery mode, the config's state (missing, invalid, not approved, changed since approval, approved), the checks it would run, pending files and the last run.
- `on` / `off`: switch the mod for this session. `off` takes effect at once, even mid-turn; a check already running is left to finish but its results are dropped, and no further check of that run starts. `revoke` does the same.
- `approve`: approve the config's current text for this project and show what was approved. Only accepted when you type it yourself at the prompt; not from `claude -p`, another plugin or another session.
- `revoke`: remove the approval for this project.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on for new sessions. `/edit-diagnostics on|off` overrides it per session. |
| `delivery` | `tool` | `tool` or `batch` (above). |
| `timeoutMs` | `5000` | Longest a single check may run, in ms (500 to 30,000). |
| `batchTimeoutMs` | `10000` | Total time all checks of one run may take, in ms (1,000 to 30,000). |

## Cost

No model calls. The cost is the checks' own run time, which Claude waits for after each edit (at most `batchTimeoutMs`), and the report's tokens: at most 30 findings and 8,000 characters per report, and nothing at all for edits no check covers. Reports stay in the conversation, so repeated findings are counted instead of repeated.

## Limitations

- Checks run synchronously; there's no late delivery of slow results. A slow project check needs a higher `timeoutMs` or a faster command.
- `tool` mode runs the checks once per edit; `batch` mode is unverified live on 2.1.310 because the managed plugin skipped its hook.
- Headless runs (`claude -p`) can't approve; they use an approval made earlier in an interactive session.
- No ESLint parser: ESLint wasn't available to capture real output from. Use the `json` format through a wrapper.
- Paths in a check's output are resolved on disk (links followed) to match them with edited files, up to 200 distinct paths per check; past that a path reached through a link may count as another file.
- At most four checks, 50 file arguments per check per run, and 200 tracked files per conversation (the oldest are forgotten and become unbaselined again).
- Turning the mod off can't stop a command that is already running; it runs until it exits or times out.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-edit-diagnostics
claude plugin install edit-diagnostics@edit-diagnostics --scope user
```

Or from inside Claude Code: `/plugin install edit-diagnostics --marketplace chrisvaillancourt/claude-edit-diagnostics`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update edit-diagnostics
claude plugin update edit-diagnostics@edit-diagnostics
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
