// Runs `session` and `ui-resume` on a throwaway repository (no Docker). The editor's state is supplied through
// N8N_DEV_TEST_EDITOR_STATE, so these tests never depend on, or touch, a real editor on the machine running them.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hashOf = (wf) => createHash("sha256").update(JSON.stringify(wf)).digest("hex");
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const HOUR = 3600_000;

const workflow = (text) => ({
  name: "Demo", nodes: [
    { id: "t1", name: "Incoming", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "demo" } },
    { id: "c1", name: "Compose", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [200, 0], parameters: { text } },
  ],
  connections: { Incoming: { main: [[{ node: "Compose", type: "main", index: 0 }]] } },
});

// A repository with a saved editor session in which the person changed one text; `hoursAgo` says when it was saved.
function makeRepo({ hoursAgo = 2, changed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-session-"));
  fs.cpSync(path.join(ROOT, "harness"), path.join(dir, "harness"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  const real = workflow("ALERT: down");
  write(path.join(dir, "flows/demo/workflow.json"), JSON.stringify(real, null, 2) + "\n");
  write(path.join(dir, "flows/demo/tests/01.yaml"), "test: Down\nassert:\n  - node \"Compose\" called 1 time\n");
  write(path.join(dir, ".n8n-dev/ui-variants/v1.json"), JSON.stringify(real));
  const exported = path.join(dir, ".n8n-dev/ui-export/v1.json");
  write(exported, JSON.stringify(workflow(changed ? "OLALA: down" : "ALERT: down")));
  const when = new Date(Date.now() - hoursAgo * HOUR);
  fs.utimesSync(exported, when, when);
  write(path.join(dir, ".n8n-dev/ui-manifest.json"), JSON.stringify({
    workflowDir: "flows/demo", workflowFile: "flows/demo/workflow.json", realHash: hashOf(real),
    variantsDir: ".n8n-dev/ui-variants", exportDir: ".n8n-dev/ui-export", variants: [{ id: "v1", test: "Down" }],
    createdAt: new Date(Date.now() - (hoursAgo + 1) * HOUR).toISOString(),
  }));
  return dir;
}

const cli = (dir, editor, ...args) => {
  const env = { ...process.env, N8N_DEV_TEST_EDITOR_STATE: editor }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(dir, "harness/n8n-dev.mjs"), ...args], { cwd: dir, encoding: "utf8", env });
  const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
  return { status: r.status, json: line ? JSON.parse(line) : null, stderr: r.stderr };
};
const session = (dir, editor = "none") => cli(dir, editor, "session", "--json").json;

test("with nothing recorded, nothing is left over", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-session-"));
  fs.cpSync(path.join(ROOT, "harness"), path.join(dir, "harness"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  assert.equal(session(dir).kind, "none");
});

test("edits saved from a closed editor and never applied are found, with their age and what they hold", () => {
  const s = session(makeRepo({ hoursAgo: 2 }));
  assert.equal(s.kind, "saved-edits");
  assert.equal(s.workflow, "flows/demo");
  assert.equal(s.changes, 1);
  assert.equal(s.age, "about 2 hours ago");
  assert.equal(s.stale, false);
  assert.equal(s.drift, false);
});

test("old edits are marked stale, and a saved editor with nothing changed in it is not worth offering", () => {
  const old = session(makeRepo({ hoursAgo: 30 }));
  assert.equal(old.stale, true);
  assert.equal(old.age, "yesterday");
  assert.equal(session(makeRepo({ changed: false })).kind, "none");
});

test("once the edits are applied they are no longer offered; undoing the apply brings them back", () => {
  const dir = makeRepo();
  assert.equal(session(dir).kind, "saved-edits");
  assert.equal(cli(dir, "none", "pull", "flows/demo", "--apply", "--json").json.state, "applied");
  assert.equal(session(dir).kind, "none", "applied, so nothing is waiting");
  assert.equal(cli(dir, "none", "undo", "--json").json.state, "restored");
  assert.equal(session(dir).kind, "saved-edits", "control: after undo the saved edits are waiting again");
});

test("a workflow that changed since the editor opened is flagged", () => {
  const dir = makeRepo();
  write(path.join(dir, "flows/demo/workflow.json"), JSON.stringify(workflow("someone else's change"), null, 2) + "\n");
  assert.equal(session(dir).drift, true);
});

test("an editor that is still there is reported with its age, running or stopped, and wins over saved edits", () => {
  const dir = makeRepo({ hoursAgo: 2 });
  const running = session(dir, "running");
  assert.deepEqual([running.kind, running.age], ["editor-running", "about 3 hours ago"]);
  assert.equal(session(dir, "stopped").kind, "editor-stopped");
  assert.equal(session(dir, "unknown").kind, "saved-edits", "with Docker not running, saved edits can still be found");
});

test("ui-resume brings nothing back when there is no earlier editor, or the workflow moved on", () => {
  const dir = makeRepo();
  assert.equal(cli(dir, "none", "ui-resume", "--json").json.state, "nothing-to-resume");
  assert.equal(cli(dir, "unknown", "ui-resume", "--json").json.state, "nothing-to-resume");
  write(path.join(dir, "flows/demo/workflow.json"), JSON.stringify(workflow("someone else's change"), null, 2) + "\n");
  const drifted = cli(dir, "stopped", "ui-resume", "--json");
  assert.equal(drifted.json.state, "drifted");
  assert.equal(drifted.json.session.drift, true);
});

test("ui-discard throws away the editor's saved edits and nothing else: the workflow, its tests and the undo record stay", () => {
  const dir = makeRepo();
  assert.equal(cli(dir, "none", "pull", "flows/demo", "--apply", "--json").json.state, "applied");
  const workflowAfter = fs.readFileSync(path.join(dir, "flows/demo/workflow.json"), "utf8");
  const testBefore = fs.readFileSync(path.join(dir, "flows/demo/tests/01.yaml"), "utf8");
  const r = cli(dir, "none", "ui-discard", "--json");
  assert.deepEqual([r.status, r.json.state, r.json.cleaned], [0, "discarded", true]);
  for (const gone of [".n8n-dev/ui-export", ".n8n-dev/ui-variants", ".n8n-dev/ui-manifest.json"]) assert.equal(fs.existsSync(path.join(dir, gone)), false, gone);
  assert.equal(fs.readFileSync(path.join(dir, "flows/demo/workflow.json"), "utf8"), workflowAfter, "the applied change stays");
  assert.equal(fs.readFileSync(path.join(dir, "flows/demo/tests/01.yaml"), "utf8"), testBefore);
  assert.ok(fs.existsSync(path.join(dir, ".n8n-dev/last-apply.json")), "the record that undo needs stays");
  assert.equal(cli(dir, "none", "undo", "--json").json.state, "restored", "undo still works after a discard");
  assert.equal(session(dir).kind, "none", "and nothing is offered afterwards");
});

test("after a discard, the saved edits are no longer offered", () => {
  const dir = makeRepo();
  assert.equal(session(dir).kind, "saved-edits");
  cli(dir, "none", "ui-discard", "--json");
  assert.equal(session(dir).kind, "none");
});
