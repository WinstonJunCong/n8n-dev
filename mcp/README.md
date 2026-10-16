# mcp/: use n8n-dev from an AI assistant

**Status: work in progress.** This folder holds the guard rails and, in later steps, the server itself. Nothing here is callable yet.

## What it is

A small local program that lets an AI assistant (Claude, Cursor, Kiro, OpenCode and other apps that support MCP) use n8n-dev for someone who does not use a terminal: check a workflow, try a change in the sealed editor, bring the change back, and send it for review.

It is a **thin, guarded wrapper over the same command line** you can run yourself. There is no second copy of the logic, so the two cannot drift apart.

## Rules the server follows

These are enforced in code and pinned by tests, not left to instructions:

- **No shell.** It runs fixed commands with a fixed list of arguments. It never builds a command from text, and `boundary.test.mjs` fails if anything in this folder uses `exec`, a shell option or `eval`.
- **Workflows are named by folder, and only by plain name.** No paths, no `..`, nothing that could point outside the workflows folder (`guards.mjs`).
- **Nothing real is reachable.** It never calls a live n8n or any outside service, and never handles credentials. The sealed editor keeps its own protections (see the main README).
- **Writing needs two deliberate calls.** A preview returns a one-time code, and the action that follows must present it. A code works once, expires, belongs to what was previewed, and is dropped after wrong tries.
- **Pushing is rate limited.**
- **The core never depends on this folder.** `boundary.test.mjs` fails if anything in `harness/` imports from `mcp/`, so n8n-dev works the same with or without it.

## Layout

| File | Purpose |
| --- | --- |
| `guards.mjs` | The safety rules as pure, testable functions |
| `guards.test.mjs` | Tests for them, including attempts to break out |
| `boundary.test.mjs` | Keeps the core independent and the server shell-free |

Still to come: the tools themselves, the protocol layer, and the setup for each app.
