# mcp/: use n8n-dev from an AI assistant

**Status: work in progress.** The server runs and its tools work. `submit`, the per-app setup files and a one-click bundle are still to come.

## Try it

You need Node.js 20 or newer, and `npm install` run once in the repo. The server is started by the app, not by you: point your app at the command `node mcp/server.mjs` (give the full path to the file). For example, in Claude Code:

```bash
claude mcp add n8n-dev -- node /full/path/to/your-repo/mcp/server.mjs
```

Then start a new session and ask it to list your n8n workflows. To point the server at a different repo than the one it lives in, set `N8N_DEV_ROOT` to that repo's folder.

## Two protocol eras, one set of tools

MCP changed in revision 2026-07-28: the older versions open with an `initialize` handshake, the newer one has no handshake and sends the version with every request. Apps in the wild speak either, so the server answers both. The official library (`@modelcontextprotocol/server`) does the protocol work; the tools are registered once and served to both. `server.test.mjs` starts the real server and speaks each era to it.

One known gap in the library: it checks the protocol version on a connection's first request, then pins the connection, so a later request claiming an unsupported version is still served. It is shown as a `todo` in `server.test.mjs`. It is harmless here, because nothing depends on the claimed version and every request on a standard-input connection comes from the one app that started it.

## What it is

A small local program that lets an AI assistant (Claude, Cursor, Kiro, OpenCode and other apps that support MCP) use n8n-dev for someone who does not use a terminal: check a workflow, try a change in the sealed editor, bring the change back, and send it for review.

It is a **thin, guarded wrapper over the same command line** you can run yourself. There is no second copy of the logic, so the two cannot drift apart.

## Tools

| Tool | What it does |
| --- | --- |
| `list_workflows` | Lists the workflows in the repo, with their test counts |
| `check_workflow` | Runs the readiness scan, structure check and fake tests; returns the report |
| `ui_start` | Opens the sealed editor with the faked tests loaded; returns the address and login |
| `explain_test_failures` | After a change, finds tests that fail only because they expect the old wording and says so plainly; never touches any other failure |
| `update_tests` | Updates just those tests, after the person confirms (one-time code); `undo_change` takes it back too |
| `draft_test_preview` | Turns what the person says should happen into a test and shows it in plain when/then sentences; writes nothing |
| `draft_test_save` | Adds the previewed test (one-time code and the person's own words); it fails until the workflow does what it says |
| `draft_test_remove` | Takes back a test that `draft_test_save` added, if nobody edited it since |
| `submit_preview` | Shows exactly what would be sent for review and whether every gate passes; sends nothing (the send step is next) |
| `submit` | Sends the previewed change to the team for review as a new proposal (needs the code and the person's own words); returns the review link |
| `undo_change` | Puts the workflow back as it was before the last applied change (one step, only if untouched since) |
| `ui_resume` | Brings back an editor left over from earlier (stopped by a restart or still running) with its changes, if the workflow has not moved on |
| `ui_discard` | Throws away an earlier editor and changes saved from it that were never applied (needs the person's own words); never touches the workflow or its tests |
| `ui_stop` | Only when the person says they are finished (their words are required, and not within 30 s of opening): saves any edits, closes the editor, and summarises what changed |
| `status` | Reports an editor, or saved changes never applied, left over from earlier, how old they are, and the choices; changes nothing |
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
| `register.mjs` | Turns the tools into protocol registrations (strict input schemas, plain error messages) |
| `server.mjs` | The program an app starts. The only file that uses the MCP library |
| `stdout-guard.mjs` | Sends anything printed with `console.log` to standard error, so only protocol messages reach the app |
| `*.test.mjs` | Tests for each, including attempts to break out and a full conversation in both protocol eras |

Two more rules are pinned by `boundary.test.mjs`: nothing here may print to standard output (it belongs to the protocol), and `mcp/` may only use Node's own modules, its own files, `@modelcontextprotocol/server` and `zod`.

Still to come: setup files for each app, `submit`, and a one-click bundle.
