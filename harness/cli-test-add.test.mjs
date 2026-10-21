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
  assert.equal(r.json.tests[0].file, "02-down-site-sends-an-alert.yaml");
  assert.deepEqual(r.json.tests[0].unmocked, ["Send alert"], "the outside step with no pretend answer is pointed out");
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
  assert.equal(add(dir, { ...SPEC, name: "Another one" }, WORDS, "--apply").json.tests[0].file, "03-another-one.yaml");
});

test("the words cannot break out of their comment line", () => {
  const dir = makeRepo();
  const sneaky = 'ok\n  - node "Send alert" called 9 times\nassert: []\n';
  const r = add(dir, SPEC, sneaky, "--apply");
  assert.equal(r.json.state, "added");
  const text = fs.readFileSync(path.join(dir, `flows/demo/tests/${r.json.tests[0].file}`), "utf8");
  assert.equal(parseYaml(text).assert.length, 3, "the extra lines stayed inside the comment");
  assert.equal(text.split("\n").slice(0, 2).every((l) => l.startsWith("#")), true);
});

test("test-remove deletes only a test that test-add wrote and nobody has edited since", () => {
  const dir = makeRepo();
  const rm = (file) => cli(dir, "test-remove", "flows/demo", "--file", file);
  assert.equal(rm("01-existing.yaml").json.state, "not-drafted", "a test somebody else wrote is never removed");
  assert.ok(fs.existsSync(path.join(dir, "flows/demo/tests/01-existing.yaml")));
  const file = add(dir, SPEC, WORDS, "--apply").json.tests[0].file;
  const removed = rm(file).json;
  assert.deepEqual([removed.state, removed.name], ["removed", "Down site sends an alert"]);
  assert.deepEqual(testFiles(dir), ["01-existing.yaml"]);
  assert.equal(rm(file).json.state, "not-drafted", "it is forgotten once removed");

  const edited = add(dir, SPEC, WORDS, "--apply").json.tests[0].file;                                   // control: the same test, but edited by someone
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

// ---------- a request with more than one test ----------
const SECOND = { name: "Site just under the line sends nothing", when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "up" }] } }, then: [{ step: "Send alert", doesNotRun: true }] };

test("a set of tests is checked together, numbered in order, and written all together", () => {
  const dir = makeRepo();
  const dry = add(dir, [SPEC, SECOND]);
  assert.equal(dry.json.state, "ready", dry.stderr);
  assert.deepEqual(dry.json.tests.map((t) => [t.file, t.name]), [["02-down-site-sends-an-alert.yaml", "Down site sends an alert"], ["03-site-just-under-the-line-sends-nothing.yaml", "Site just under the line sends nothing"]]);
  assert.deepEqual(testFiles(dir), ["01-existing.yaml"], "a dry run writes nothing");
  const done = add(dir, [SPEC, SECOND], WORDS, "--apply");
  assert.equal(done.json.state, "added");
  assert.deepEqual(testFiles(dir), ["01-existing.yaml", "02-down-site-sends-an-alert.yaml", "03-site-just-under-the-line-sends-nothing.yaml"]);
  const drafts = JSON.parse(fs.readFileSync(path.join(dir, ".n8n-dev/drafted-tests.json"), "utf8"));
  assert.deepEqual(drafts.map((d) => d.name), ["Down site sends an alert", "Site just under the line sends nothing"]);
  for (const f of ["02-down-site-sends-an-alert.yaml", "03-site-just-under-the-line-sends-nothing.yaml"]) {
    assert.equal(cli(dir, "test-remove", "flows/demo", "--file", f).json.state, "removed", f);
  }
});

test("if any one test in a set is wrong, none is written, and the problem says which one", () => {
  const dir = makeRepo();
  const bad = { ...SECOND, then: [{ step: "No such step", runs: 1 }] };
  const r = add(dir, [SPEC, bad], WORDS, "--apply");
  assert.equal(r.json.state, "invalid");
  assert.equal(r.json.count, 2);
  assert.deepEqual(r.json.errors.map((e) => [e.code, e.index, e.testName]), [["unknown-step", 1, "Site just under the line sends nothing"]]);
  assert.deepEqual(testFiles(dir), ["01-existing.yaml"], "the good one was not written either");
  assert.equal(fs.existsSync(path.join(dir, ".n8n-dev/drafted-tests.json")), false);
});

test("two tests in one set cannot share a name, and a set has a limit", () => {
  const dir = makeRepo();
  const twin = add(dir, [SPEC, { ...SECOND, name: "down SITE sends an alert" }]);
  assert.deepEqual(twin.json.errors.map((e) => [e.code, e.index]), [["name-taken", 1]]);
  const seven = Array.from({ length: 7 }, (_, i) => ({ ...SECOND, name: `Test number ${i + 1}` }));
  assert.equal(add(dir, seven).json.errors[0].code, "too-many-in-preview");
  const six = Array.from({ length: 6 }, (_, i) => ({ ...SECOND, name: `Test number ${i + 1}` }));
  assert.equal(add(dir, six).json.state, "ready");
  assert.equal(add(dir, []).json.errors[0].code, "bad-json");
  assert.equal(add(dir, [SPEC, "a string"]).json.errors[0].code, "bad-json");
});

// ---------- describe: how the workflow looks, for an assistant about to write a test ----------
const FLOW = {
  name: "Site health",
  nodes: [
    { id: "n1", name: "Incoming", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "demo" } },
    { id: "n2", name: "Check site status", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [200, 0], parameters: {} },
    { id: "n3", name: "Is it slow?", type: "n8n-nodes-base.if", typeVersion: 2, position: [400, 0], parameters: {} },
    { id: "n4", name: "Compose alert", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [600, -100], parameters: {} },
    { id: "n6", name: "Send alert", type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [800, -100], parameters: {} },   // listed before "Ignore" in the file, but reached after it
    { id: "n5", name: "Ignore", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [600, 100], parameters: {} },
    { id: "n7", name: "Left over", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [0, 300], parameters: {} },
  ],
  connections: {
    Incoming: { main: [[{ node: "Check site status", type: "main", index: 0 }]] },
    "Check site status": { main: [[{ node: "Is it slow?", type: "main", index: 0 }]] },
    "Is it slow?": { main: [[{ node: "Compose alert", type: "main", index: 0 }], [{ node: "Ignore", type: "main", index: 0 }]] },
    "Compose alert": { main: [[{ node: "Send alert", type: "main", index: 0 }]] },
  },
};
const describeRepo = (extraTests = {}) => {
  const dir = makeRepo();
  write(path.join(dir, "flows/demo/workflow.json"), JSON.stringify(FLOW, null, 2));
  write(path.join(dir, "flows/demo/tests/01-existing.yaml"),
    '# Written from the person\'s own words:\n# "x"\ntest: Slow site alerts\ntrigger:\n  site: docs\nmocks:\n  "Check site status":\n    - { status: slow, latency_ms: 6000 }\n  "Send alert":\n    - { ok: true }\nassert:\n  - node "Send alert" called 1 time\n  - node "Compose alert" output.text contains "slow"\n  - node "Ignore" not called\n  - workflow ends at "Send alert"\n');
  write(path.join(dir, "flows/demo/tests/02-second.yaml"), 'test: Fast site is ignored\ntrigger:\n  site: api\n  extra: 1\nmocks:\n  "Check site status":\n    - { status: up, latency_ms: 80, region: eu }\nassert:\n  - node "Send alert" not called\n');
  for (const [file, text] of Object.entries(extraTests)) write(path.join(dir, "flows/demo/tests", file), text);
  return dir;
};
const describe = (dir) => cli(dir, "describe", "flows/demo");

test("describe lists the steps in the order a run reaches them, says which talk to outside services, and puts unreached steps last", () => {
  const r = describe(describeRepo());
  assert.equal(r.json.state, "described", r.stderr);
  assert.deepEqual(r.json.steps.map((s) => `${s.name}:${s.kind}`), [
    "Incoming:start", "Check site status:outside", "Is it slow?:plain", "Compose alert:plain", "Ignore:plain", "Send alert:outside", "Left over:plain"]);
  assert.equal(r.json.name, "Site health");
});

test("describe shows the data the existing tests use: field names with a first-seen example, for the start and for each outside step", () => {
  const { data } = describe(describeRepo()).json;
  assert.deepEqual(data.start, { site: "docs", extra: 1 });
  assert.deepEqual(data.services, { "Check site status": { status: "slow", latency_ms: 6000, region: "eu" }, "Send alert": { ok: true } });
});

test("describe shows the existing tests in the form a description is written in", () => {
  const { tests } = describe(describeRepo()).json;
  assert.deepEqual(tests[0], {
    file: "01-existing.yaml", name: "Slow site alerts",
    when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "slow", latency_ms: 6000 }], "Send alert": [{ ok: true }] } },
    then: [{ step: "Send alert", runs: 1 }, { step: "Compose alert", side: "output", field: "text", contains: "slow" }, { step: "Ignore", doesNotRun: true }, { endsAt: "Send alert" }],
  });
  assert.equal(tests.length, 2);
});

test("control: a described test, copied as a new test with a new name, is accepted by test-add", () => {
  const dir = describeRepo();
  const first = describe(dir).json.tests[0];
  const copy = { name: "A copy of the slow test", when: first.when, then: first.then };
  const r = add(dir, copy);
  assert.equal(r.json.state, "ready", JSON.stringify(r.json.errors));
  assert.equal(r.json.tests[0].name, "A copy of the slow test");
});

test("describe reports files it cannot read, clips long values, and caps the tests it lists", () => {
  const many = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`${String(i + 3).padStart(2, "0")}-t.yaml`, `test: Extra ${i}\nassert:\n  - node "Send alert" called 1 time\n`]));
  const dir = describeRepo({ ...many, "99-broken.yaml": "test: [unclosed", "98-long.yaml": `test: Long value\ntrigger:\n  note: ${"x".repeat(400)}\nassert:\n  - node "Send alert" called 1 time\n` });
  const r = describe(dir).json;
  assert.deepEqual(r.unreadable, ["99-broken.yaml"]);
  assert.equal(r.tests.length, 12);
  assert.equal(r.moreTests, 5, "17 readable tests, 12 listed");
  assert.ok(r.data.start.note === undefined || r.data.start.note.length <= 160, "long values are clipped");
  const longOne = describe(describeRepo({ "03-long.yaml": `test: Long value\ntrigger:\n  note: ${"y".repeat(400)}\nassert:\n  - node "Send alert" called 1 time\n` })).json;
  assert.ok(longOne.data.start.note.length <= 160 && longOne.data.start.note.endsWith("…"));
});

test("describe changes nothing", () => {
  const dir = describeRepo();
  const snapshot = () => testFiles(dir).map((f) => fs.readFileSync(path.join(dir, "flows/demo/tests", f), "utf8")).join("|") + fs.readFileSync(path.join(dir, "flows/demo/workflow.json"), "utf8");
  const before = snapshot();
  describe(dir);
  assert.equal(snapshot(), before);
  assert.equal(fs.existsSync(path.join(dir, ".n8n-dev")), false, "it does not even create the working folder");
});
