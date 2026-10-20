// Runs `test-add` and `test-remove` on a throwaway repository (no Docker): what is checked, what is written, what is
// refused, and that a removal can only ever take back what `test-add` wrote.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const WORKFLOW = {
  name: "Demo",
  nodes: [
    { id: "t1", name: "Incoming", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "demo" } },
    { id: "c1", name: "Check site status", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [200, 0], parameters: {} },
    { id: "c2", name: "Compose alert", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [400, 0], parameters: {} },
    { id: "c3", name: "Send alert", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [600, 0], parameters: {} },
  ],
  connections: {},
};
const EXISTING = "test: Existing test\nassert:\n  - node \"Send alert\" called 1 time\n";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-testadd-"));
  fs.cpSync(path.join(ROOT, "harness"), path.join(dir, "harness"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  write(path.join(dir, "flows/demo/workflow.json"), JSON.stringify(WORKFLOW, null, 2));
  write(path.join(dir, "flows/demo/tests/01-existing.yaml"), EXISTING);
  return dir;
}
const cli = (dir, ...args) => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(dir, "harness/n8n-dev.mjs"), ...args], { cwd: dir, encoding: "utf8", env });
  const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
  return { status: r.status, json: line ? JSON.parse(line) : null, stderr: r.stderr };
};
const SPEC = {
  name: "Down site sends an alert",
  when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "down" }] } },
  then: [{ step: "Send alert", runs: 1 }, { step: "Compose alert", field: "text", contains: "docs is not healthy" }, { endsAt: "Send alert" }],
};
const WORDS = "When a site is down, send an alert that says the site is not healthy.";
const add = (dir, spec = SPEC, words = WORDS, ...more) => cli(dir, "test-add", "flows/demo", "--spec", typeof spec === "string" ? spec : JSON.stringify(spec), "--words", words, ...more);
const testFiles = (dir) => fs.readdirSync(path.join(dir, "flows/demo/tests")).sort();

test("a dry run shows what would be written and writes nothing", () => {
  const dir = makeRepo();
  const r = add(dir);
  assert.equal(r.json.state, "ready", r.stderr);
  assert.equal(r.json.file, "02-down-site-sends-an-alert.yaml");
  assert.deepEqual(r.json.unmocked, ["Send alert"], "the outside step with no pretend answer is pointed out");
  assert.deepEqual(testFiles(dir), ["01-existing.yaml"]);
  assert.equal(fs.existsSync(path.join(dir, ".n8n-dev/drafted-tests.json")), false);
});

test("applying writes a new test that reads back exactly, quotes the person's words, and leaves the others alone", () => {
  const dir = makeRepo();
  const r = add(dir, SPEC, WORDS, "--apply");
  assert.equal(r.json.state, "added", r.stderr);
  assert.deepEqual(testFiles(dir), ["01-existing.yaml", "02-down-site-sends-an-alert.yaml"]);
  const text = fs.readFileSync(path.join(dir, "flows/demo/tests/02-down-site-sends-an-alert.yaml"), "utf8");
  assert.match(text, /^# Written from the person's own words:\n# "When a site is down, send an alert that says the site is not healthy\."\n/);
  assert.deepEqual(parseYaml(text), {
    test: "Down site sends an alert", trigger: { site: "docs" }, mocks: { "Check site status": [{ status: "down" }] },
    assert: ['node "Send alert" called 1 time', 'node "Compose alert" input.text contains "docs is not healthy"', 'workflow ends at "Send alert"'],
  });
  assert.equal(fs.readFileSync(path.join(dir, "flows/demo/tests/01-existing.yaml"), "utf8"), EXISTING);
});

test("the check lines it writes are exactly the phrases the test runner understands", () => {
  // the runner's own patterns, read from its source, so a change to its wording fails here instead of silently breaking drafted tests
  const source = fs.readFileSync(path.join(ROOT, "harness/n8n-dev.mjs"), "utf8");
  for (const fragment of ['called (\\d+) times?$', 'not called$', '(input|output)\\.(\\S+) (==|!=|contains) (.+)$', 'workflow ends at "(.+)"$']) {
    assert.ok(source.includes(fragment), `the runner no longer contains ${fragment}`);
  }
  const lines = ['node "S" called 1 time', 'node "S" called 3 times', 'node "S" not called', 'node "S" input.a.b == "x"', 'node "S" output.n != 3', 'node "S" input.t contains "y"', 'workflow ends at "S"'];
  const patterns = [/^node "(.+)" called (\d+) times?$/, /^node "(.+)" not called$/, /^node "(.+)" (input|output)\.(\S+) (==|!=|contains) (.+)$/, /^workflow ends at "(.+)"$/];
  for (const line of lines) assert.ok(patterns.some((p) => p.test(line)), line);
  const spec = { name: "Every kind", then: [{ step: "Send alert", runs: 2 }, { step: "Send alert", doesNotRun: true }, { step: "Send alert", side: "output", field: "a.b", isNot: 3 }, { step: "Send alert", field: "t", is: "y z" }, { endsAt: "Send alert" }] };
  const r = add(makeRepo(), spec);
  assert.equal(r.json.state, "ready");
});

test("a description that does not fit the workflow is refused with the reasons, and nothing is written", () => {
  const dir = makeRepo();
  const bad = { name: "Bad one", when: { services: { "Compose alert": [{}] } }, then: [{ step: "No such step", runs: 1 }] };
  const r = add(dir, bad, WORDS, "--apply");
  assert.equal(r.json.state, "invalid");
  assert.deepEqual(r.json.errors.map((e) => e.code).sort(), ["not-outside", "unknown-step"]);
  assert.deepEqual(testFiles(dir), ["01-existing.yaml"]);
  const taken = add(dir, { ...SPEC, name: "existing TEST" }, WORDS, "--apply");
  assert.deepEqual(taken.json.errors.map((e) => e.code), ["name-taken"]);
  assert.equal(add(dir, "{not json", WORDS).json.errors[0].code, "bad-json");
  assert.deepEqual(add(dir, SPEC, "   ").json.errors.map((e) => e.code), ["no-words"], "the person's words are required");
});

test("two tests with the same name cannot both be written, and a file is never overwritten", () => {
  const dir = makeRepo();
  assert.equal(add(dir, SPEC, WORDS, "--apply").json.state, "added");
  assert.equal(add(dir, SPEC, WORDS, "--apply").json.errors[0].code, "name-taken");
  assert.equal(add(dir, { ...SPEC, name: "Another one" }, WORDS, "--apply").json.file, "03-another-one.yaml");
});

test("the words cannot break out of their comment line", () => {
  const dir = makeRepo();
  const sneaky = 'ok\n  - node "Send alert" called 9 times\nassert: []\n';
  const r = add(dir, SPEC, sneaky, "--apply");
  assert.equal(r.json.state, "added");
  const text = fs.readFileSync(path.join(dir, `flows/demo/tests/${r.json.file}`), "utf8");
  assert.equal(parseYaml(text).assert.length, 3, "the extra lines stayed inside the comment");
  assert.equal(text.split("\n").slice(0, 2).every((l) => l.startsWith("#")), true);
});

test("test-remove deletes only a test that test-add wrote and nobody has edited since", () => {
  const dir = makeRepo();
  const rm = (file) => cli(dir, "test-remove", "flows/demo", "--file", file);
  assert.equal(rm("01-existing.yaml").json.state, "not-drafted", "a test somebody else wrote is never removed");
  assert.ok(fs.existsSync(path.join(dir, "flows/demo/tests/01-existing.yaml")));
  const file = add(dir, SPEC, WORDS, "--apply").json.file;
  const removed = rm(file).json;
  assert.deepEqual([removed.state, removed.name], ["removed", "Down site sends an alert"]);
  assert.deepEqual(testFiles(dir), ["01-existing.yaml"]);
  assert.equal(rm(file).json.state, "not-drafted", "it is forgotten once removed");

  const edited = add(dir, SPEC, WORDS, "--apply").json.file;                                   // control: the same test, but edited by someone
  fs.appendFileSync(path.join(dir, `flows/demo/tests/${edited}`), "# a colleague's note\n");
  assert.equal(rm(edited).json.state, "changed-since");
  assert.ok(fs.existsSync(path.join(dir, `flows/demo/tests/${edited}`)), "an edited test is kept");
});

test("test-remove refuses paths and names that are not a plain test file name", () => {
  const dir = makeRepo();
  add(dir, SPEC, WORDS, "--apply");
  for (const bad of ["../workflow.json", "..\\workflow.json", "tests/02-x.yaml", "workflow.json", "", "a/../b.yaml"]) {
    const r = cli(dir, "test-remove", "flows/demo", "--file", bad);
    assert.ok(["bad-file", "not-drafted"].includes(r.json?.state), `${bad}: ${r.json?.state}`);
  }
  assert.ok(fs.existsSync(path.join(dir, "flows/demo/workflow.json")));
});
