// Runs the real command line (no Docker) on a throwaway repository to prove the whole apply -> update tests -> undo chain
// on actual files: what is written, what is kept, what is refused, and that undo restores the exact bytes.
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

const workflow = (text) => ({
  name: "Demo", nodes: [
    { id: "t1", name: "Incoming", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "demo" } },
    { id: "c1", name: "Compose", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [200, 0], parameters: { text } },
  ],
  connections: { Incoming: { main: [[{ node: "Compose", type: "main", index: 0 }]] } },
});

const TEST_YAML = [
  "test: Down site sends an alert",
  "trigger:                       # fake incoming body",
  "  site: docs",
  "assert:",
  "  - node \"Compose\" called 1 time",
  "  - 'node \"Compose\" output.text contains \"ALERT: down\"'",
  "",
].join("\n");

// A repository with one workflow, one test, and a saved editor session in which the person changed the text.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-cli-"));
  fs.cpSync(path.join(ROOT, "harness"), path.join(dir, "harness"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  const real = workflow("ALERT: down");
  const original = JSON.stringify(real, null, 2) + "\n";
  write(path.join(dir, "flows/demo/workflow.json"), original);
  write(path.join(dir, "flows/demo/tests/01-down.yaml"), TEST_YAML);
  write(path.join(dir, ".n8n-dev/ui-variants/v1.json"), JSON.stringify(real));
  write(path.join(dir, ".n8n-dev/ui-export/v1.json"), JSON.stringify(workflow("OLALA: down")));
  write(path.join(dir, ".n8n-dev/ui-manifest.json"), JSON.stringify({
    workflowDir: "flows/demo", workflowFile: "flows/demo/workflow.json", realHash: hashOf(real),
    variantsDir: ".n8n-dev/ui-variants", exportDir: ".n8n-dev/ui-export", variants: [{ id: "v1", test: "Down" }],
  }));
  return { dir, original };
}

const cli = (dir, ...args) => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;          // a nested test run would otherwise report to this one
  const r = spawnSync(process.execPath, [path.join(dir, "harness/n8n-dev.mjs"), ...args], { cwd: dir, encoding: "utf8", env });
  const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
  return { status: r.status, json: line ? JSON.parse(line) : null, stderr: r.stderr };
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const WF = "flows/demo/workflow.json", T1 = "flows/demo/tests/01-down.yaml", RECORD = ".n8n-dev/last-apply.json";

const failingReport = (dir, tests) => { const f = path.join(dir, "report.json"); write(f, JSON.stringify({ tests })); return f; };
const WORDING_FAILURE = [{
  file: "01-down.yaml", name: "Down site sends an alert", pass: false,
  checks: [
    { assertion: 'node "Compose" called 1 time', pass: true, detail: "called 1 time(s)" },
    { assertion: 'node "Compose" output.text contains "ALERT: down"', pass: false, detail: 'output.text = "OLALA: down"' },
  ],
}];

// ---------- apply keeps what undo needs ----------
test("apply writes the change and keeps a record; undo restores the exact bytes and removes the record", () => {
  const { dir, original } = makeRepo();
  const applied = cli(dir, "pull", "flows/demo", "--apply", "--json");
  assert.equal(applied.json.state, "applied", applied.stderr);
  assert.match(read(dir, WF), /OLALA: down/);
  assert.ok(exists(dir, RECORD), "apply must keep a record");

  const undone = cli(dir, "undo", "--json");
  assert.equal(undone.json.state, "restored");
  assert.equal(read(dir, WF), original, "undo must restore the exact bytes");
  assert.equal(exists(dir, RECORD), false);
  assert.equal(cli(dir, "undo", "--json").json.state, "nothing-to-undo");
});

test("a blocked apply writes nothing and keeps no record; control: the same repo applies when unblocked", () => {
  const blocked = makeRepo();
  const edited = JSON.stringify(workflow("someone else's text"), null, 2) + "\n";
  write(path.join(blocked.dir, WF), edited);                                // the workflow moved on while the editor was open
  const r = cli(blocked.dir, "pull", "flows/demo", "--apply", "--json");
  assert.equal(r.json.state, "blocked");
  assert.equal(read(blocked.dir, WF), edited);
  assert.equal(exists(blocked.dir, RECORD), false);

  const fine = makeRepo();
  assert.equal(cli(fine.dir, "pull", "flows/demo", "--apply", "--json").json.state, "applied");
  assert.ok(exists(fine.dir, RECORD));
});

test("undo refuses, and touches nothing, when the workflow was edited after the apply", () => {
  const { dir } = makeRepo();
  cli(dir, "pull", "flows/demo", "--apply", "--json");
  const later = read(dir, WF).replace("OLALA", "SOMEONE");
  write(path.join(dir, WF), later);
  assert.equal(cli(dir, "undo", "--json").json.state, "changed-since");
  assert.equal(read(dir, WF), later);
  assert.ok(exists(dir, RECORD), "the record stays so nothing is lost");
});

test("a record pointing outside the repository is never acted on", () => {
  const { dir } = makeRepo();
  cli(dir, "pull", "flows/demo", "--apply", "--json");
  const outside = path.join(os.tmpdir(), `n8n-dev-outside-${process.pid}.json`);
  write(outside, "untouched");
  const rec = JSON.parse(read(dir, RECORD));
  for (const bad of ["../../outside.json", outside, "a\\..\\..\\x.json"]) {
    write(path.join(dir, RECORD), JSON.stringify({ ...rec, workflowFile: bad }));
    assert.equal(cli(dir, "undo", "--json").json.state, "nothing-to-undo", bad);
  }
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  fs.rmSync(outside, { force: true });
});

// ---------- updating tests ----------
test("tests-fix: a dry run changes nothing; apply rewrites only the explained line and keeps the comment and valid YAML", () => {
  const { dir } = makeRepo();
  cli(dir, "pull", "flows/demo", "--apply", "--json");
  const report = failingReport(dir, WORDING_FAILURE);

  const dry = cli(dir, "tests-fix", "flows/demo", "--from-report", report, "--json");
  assert.equal(dry.json.state, "ready");
  assert.deepEqual(dry.json.updates.map((u) => [u.from, u.to]), [["ALERT: down", "OLALA: down"]]);
  assert.equal(read(dir, T1), TEST_YAML, "a dry run must not change the test");

  const applied = cli(dir, "tests-fix", "flows/demo", "--from-report", report, "--apply", "--json");
  assert.equal(applied.json.state, "applied", applied.stderr);
  const after = read(dir, T1);
  assert.match(after, /contains "OLALA: down"/);
  assert.doesNotMatch(after, /ALERT: down/);
  assert.match(after, /# fake incoming body/, "comments must survive");
  assert.match(after, /node "Compose" called 1 time/, "other lines must be untouched");
});

test("tests-fix never touches a failure the change does not explain", () => {
  const { dir } = makeRepo();
  cli(dir, "pull", "flows/demo", "--apply", "--json");
  const report = failingReport(dir, [
    { file: "01-down.yaml", name: "Other", pass: false, checks: [{ assertion: 'node "Compose" called 1 time', pass: false, detail: "called 0 time(s)" }] },
    { file: "01-down.yaml", name: "Broken", pass: false, error: "Workflow failed", checks: [] },
    // looks like the wording change, but the workflow produces something else too: swapping the text does not explain it
    { file: "01-down.yaml", name: "Looks similar", pass: false, checks: [{ assertion: 'node "Compose" output.text contains "ALERT: down"', pass: false, detail: 'output.text = "OLALA: something else entirely"' }] },
  ]);
  const r = cli(dir, "tests-fix", "flows/demo", "--from-report", report, "--apply", "--json");
  assert.equal(r.json.state, "unexplained");
  assert.deepEqual(r.json.unexplained.map((u) => u.reason).sort(), ["error", "mismatch", "not-text"]);
  assert.equal(read(dir, T1), TEST_YAML);
});

test("tests-fix says so when no change was applied, or the workflow is not the one that changed", () => {
  const { dir } = makeRepo();
  const report = failingReport(dir, WORDING_FAILURE);
  assert.equal(cli(dir, "tests-fix", "flows/demo", "--from-report", report, "--json").json.state, "no-change");
  cli(dir, "pull", "flows/demo", "--apply", "--json");
  fs.cpSync(path.join(dir, "flows/demo"), path.join(dir, "flows/other"), { recursive: true });
  assert.equal(cli(dir, "tests-fix", "flows/other", "--from-report", report, "--json").json.state, "wrong-workflow");
});

test("undo takes back the workflow and the updated tests together, and refuses if a test was edited since", () => {
  const first = makeRepo();
  cli(first.dir, "pull", "flows/demo", "--apply", "--json");
  cli(first.dir, "tests-fix", "flows/demo", "--from-report", failingReport(first.dir, WORDING_FAILURE), "--apply", "--json");
  assert.notEqual(read(first.dir, T1), TEST_YAML);
  const undone = cli(first.dir, "undo", "--json");
  assert.equal(undone.json.state, "restored");
  assert.equal(undone.json.testsRestored, 1);
  assert.equal(read(first.dir, WF), first.original);
  assert.equal(read(first.dir, T1), TEST_YAML, "the test file is back exactly");

  const second = makeRepo();                                                  // control: the same chain, but someone edits the test
  cli(second.dir, "pull", "flows/demo", "--apply", "--json");
  cli(second.dir, "tests-fix", "flows/demo", "--from-report", failingReport(second.dir, WORDING_FAILURE), "--apply", "--json");
  const edited = `${read(second.dir, T1)}# edited by someone\n`;
  write(path.join(second.dir, T1), edited);
  assert.equal(cli(second.dir, "undo", "--json").json.state, "changed-since");
  assert.equal(read(second.dir, T1), edited);
  assert.match(read(second.dir, WF), /OLALA/, "nothing was restored at all");
});
