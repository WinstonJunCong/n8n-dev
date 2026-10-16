# mcp/: use n8n-dev from an AI assistant

**Status: work in progress.** The tools and the rules behind them are written and tested. The protocol layer that lets an assistant call them is not here yet, so nothing is callable from an app so far.

## What it is

A small local program that lets an AI assistant (Claude, Cursor, Kiro, OpenCode and other apps that support MCP) use n8n-dev for someone who does not use a terminal: check a workflow, try a change in the sealed editor, bring the change back, and send it for review.

It is a **thin, guarded wrapper over the same command line** you can run yourself. There is no second copy of the logic, so the two cannot drift apart.

## Tools

| Tool | What it does |
| --- | --- |
| `list_workflows` | Lists the workflows in the repo, with their test counts |
| `check_workflow` | Runs the readiness scan, structure check and fake tests; returns the report |
| `ui_start` | Opens the sealed editor with the faked tests loaded; returns the address and login |
| `ui_stop` | Saves any edits, closes the editor, and summarises what changed |
| `status` | Says whether a sealed editor is still open |
| `pull_preview` | Shows which edits would be applied to `workflow.json`; changes nothing |
| `pull_apply` | Applies them, only with the one-time code from a preview of the same content |

Not exposed, on purpose: a shell, free file access, anything that reaches a live n8n, credentials.

## Rules the server follows

These are enforced in code and pinned by tests, not left to instructions:

- **No shell.** It runs the n8n-dev command line with a fixed list of arguments. Each argument reaches the program exactly as given, so nothing in it can act as a command. `effects.test.mjs` proves it by passing shell-looking arguments and checking nothing runs, and `boundary.test.mjs` fails if anything uses `exec`, a shell option or `eval`.
- **Only `effects.mjs` touches the disk or starts a process.** The rules (`guards.mjs`) and the tools (`tools.mjs`) get file access and a command runner handed to them, so they are tested with fakes, and a refused call is proven never to have reached the command line.
- **File access is read-only and stays inside the repo.** A path that resolves outside it is refused.
- **Workflows are named by folder, and only by plain name.** No paths, no `..`, nothing that could point outside the workflows folder. Unknown arguments are rejected.
- **Nothing real is reachable.** It never calls a live n8n or any outside service, and never handles credentials. The sealed editor keeps its own protections (see the main README).
- **Writing needs two deliberate calls.** `pull_preview` issues a one-time code only when there is something to apply and nothing blocks it. `pull_apply` needs that code, and it only works if neither the workflow file nor the saved edits have changed since the preview. A code works once, expires, belongs to one workflow, and is dropped after wrong tries.
- **The core never depends on this folder.** `boundary.test.mjs` fails if anything in `harness/` imports from `mcp/`, so n8n-dev works the same with or without it.

## Layout

| File | Purpose |
| --- | --- |
| `guards.mjs` | The safety rules as pure functions: names, ports, argument checking, one-time codes, rate limits |
| `tools.mjs` | The tools. No I/O of its own |
| `effects.mjs` | The only code that reads files or starts a process |
| `*.test.mjs` | Tests for each, including attempts to break out |

Still to come: the protocol layer, setup for each app, and `submit`.
