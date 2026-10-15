# n8n-dev

Test and review your n8n workflows before they go live.

Keep workflows as JSON files in Git, write small tests for them, and run a checker on every change. The checker runs your workflow on a throwaway copy of n8n with every outside service faked, so nothing real is ever called.

## What it does

`n8n-dev check` runs three things:

- **Readiness scan:** finds things that shouldn't be typed into a node: keys and tokens, IDs, addresses, or a call to your live n8n.
- **Structure check:** confirms every node and version exists in your n8n version, connections point at real nodes, and there is exactly one trigger.
- **Tests:** each `tests/*.yaml` fakes the incoming event and the answers from outside services, runs the real workflow logic, and checks what each step received.

Nothing real can be called. Every outside step (HTTP, databases, chat apps, anything with a credential) is swapped for fake data. A step with no fake fails the test instead of calling out. In Docker mode, n8n also runs with no network at all.

A GitHub Actions file runs the same checks on every pull request, so a failing change can't be merged.

## Quick start

Needs Node.js 18+ and Docker. On Windows, use WSL or Git Bash.

```bash
npm install
docker pull n8nio/n8n:2.43.4

# the sample workflow: should PASS
N8N_CMD=./scripts/n8n-docker.sh node harness/n8n-dev.mjs check workflows/store-pickup-reminder --report reports/good.md

# the sample bad change: should FAIL
N8N_CMD=./scripts/n8n-docker.sh node harness/n8n-dev.mjs check workflows/store-pickup-reminder \
  --workflow-file changes/store-pickup-reminder.bad-change.json --report reports/bad.md
```

Without Docker, install n8n with npm and leave `N8N_CMD` unset.

## Watch the faked tests in an editor

`check` tells you pass or fail. To *see* what each step received and returned, open the same faked tests in a real n8n editor:

```bash
node harness/n8n-dev.mjs ui workflows/site-health-alert
```

It loads one `[test] ...` workflow per test file into a sealed local n8n and prints a sign-in. Open the address it shows (`http://127.0.0.1:5678`), open a workflow, and click **Execute workflow** to watch the data move through each step. Press **Ctrl+C** to stop. Use `--port 5679` to change the port.

On the canvas, a coloured backdrop marks what the test **simulates**: the fake incoming event, and the fake reply from each outside service. Everything without a backdrop is your real workflow logic, running for real. You can poke at it, change a condition, or add nodes to see what happens.

**The chamber is sealed:**
- **No way out.** n8n runs on an internal Docker network with no route to the internet or your local network, for every node, including Code nodes.
- **Your files are not in it.** The repo is not mounted. n8n only sees its own throwaway storage.
- **One window in.** A small forwarder container publishes the editor on `127.0.0.1` only, so nothing else on your network can reach it.
- **Throwaway.** Everything, including the local login, is deleted when you stop it. The execute-command and file read/write nodes are switched off.

Never paste a real key or password into it. The login it creates is a fake local one.

**Edits are not saved back.** Changes you make in the editor disappear when you stop it. To keep a change, make it in `workflow.json` and run `check` again.

Check that nothing was left behind, or prove the seal on your own machine:

```bash
bash ./scripts/n8n-chamber.sh status   # prints CLEAN, or lists anything left running
bash ./scripts/n8n-chamber.sh proof    # starts a chamber and checks it cannot reach out, then removes it
```

`ui` needs Docker. `proof` expects a normal container to reach the internet, so it will say so if you are offline.

## Start your own repo

```bash
node harness/n8n-dev.mjs init ../my-n8n-repo --workflows-dir workflows --n8n-version <your version> --live-host <your n8n host> --approver "<name>"
```

This creates a new folder with the harness, config, Docker script, CI file, PR template, a `CLAUDE.md`, and a small sample workflow (`site-health-alert`) with tests that pass straight away. It never overwrites existing files. Delete the sample once you have your own workflows.

Then put each workflow in `<workflows-dir>/<name>/workflow.json`, with its tests in `tests/*.yaml`.

## Configuration

Everything specific to you lives in `config/readiness.json`. `config/readiness.example.json` is a neutral starting point.

| Field | What it does |
| --- | --- |
| `n8nVersion` | The n8n version tests run on. Pin it to match your live n8n. |
| `workflowsDir` | Folder holding one folder per workflow (default `workflows`). |
| `liveN8nHosts` | Your live n8n address. A workflow that calls it fails the scan. |
| `allowedHosts` | Addresses a workflow may call directly. Everything else must come from your config node. |
| `configHint` | Where people should read IDs and addresses from. Shown in scan messages. |
| `secretRules` | Regexes for keys and IDs that must never be typed into a node. Add your own. |
| `outsideNodeTypes` | Node types treated as outside steps. Tests must fake every one. Any node with a credential also counts. |

`.github/workflows/ci.yml` also names the workflows folder and the n8n image version. Update those two places to match your config.

## Test file format

```yaml
test: Pending pick up reminds the store
trigger: { order_id: TEST-001 }                 # fake incoming event
mocks:                                          # fake output for each outside step
  "Find order in Airtable": [ { Status: Pending Pick Up, Store: Downtown } ]
assert:
  - node "Send store reminder" called 1 time
  - node "Send store reminder" input.text contains "Downtown"
  - node "Notify customer (Respond.io)" not called
  - workflow ends at "Update reminder count"
```

Supported checks: `called N time(s)`, `not called`, `input.<field>` / `output.<field>` with `==`, `!=` or `contains`, and `workflow ends at`.

Build messages in a Set node before the send step so tests can check the text. Check full phrases, not fragments.

If an assertion contains a colon followed by a space (for example `status: down`), wrap the whole line in single quotes, or YAML will read it as a key:

```yaml
  - 'node "Send alert" input.text contains "ALERT: docs is not healthy"'
```

## What's inside

```
workflows/store-pickup-reminder/   sample workflow and 3 tests (pending, ready, cancelled)
workflows/site-health-alert/       a small, service-neutral sample workflow and 3 tests
changes/                           a sample bad change that the checker must reject
harness/n8n-dev.mjs                the checker: scan | structure | test | check | ui | init
harness/changed.mjs                which workflows a pull request affects (changed ones and their callers)
harness/init.mjs                   scaffolds a new repo
config/readiness.json              your settings
scripts/n8n-docker.sh              runs n8n in Docker, offline
scripts/n8n-chamber.sh             the sealed editor behind `ui`: proof | run | up | down | status
.github/workflows/ci.yml           the CI check
```

## How it works

n8n's command-line runner ignores pinned data, so the harness swaps each outside step for a Code node that returns the fake data, and the trigger for a Code node that returns the fake event. All tests of a workflow run in one n8n start, and the n8n node list is cached between runs.

## Limits

- Two small sample workflows, with three tests each.
- Only n8n. It relies on n8n's own command line.
- The `ui` editor needs Docker, and edits made in it are not saved back to the repo.
- Deploying to a live n8n, approvals and monitoring are not included.

## Licence

Apache License 2.0. See `LICENSE` and `NOTICE`.

n8n-dev is an independent tool and is not affiliated with or endorsed by n8n. n8n is a trademark of its owner. This repository does not include n8n; it runs the official n8n image on your own machine.
