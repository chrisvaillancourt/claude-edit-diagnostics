# edit-diagnostics

A Claude Code mod (function-hook plugin). Replace this paragraph with what the mod does and why, in two or three sentences.

> This repository is also the template for new mods: `scripts/new-mod.sh <mod-name>` creates `../claude-<mod-name>` with every `edit-diagnostics` renamed, a fresh git history and one commit. Delete this note in the new repo.

## Behavior

- What the mod does, when, and to which conversations (main only, or subagents too).
- What it costs (model calls, tokens) and how the options bound it.
- What it never does.

## Command

`/edit-diagnostics [on|off|status]`: show or set whether the mod is on for this session.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on for new sessions. `/edit-diagnostics on|off` overrides it per session. |

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
