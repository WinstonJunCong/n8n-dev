// Unit tests for mcp/tools.mjs, using a fake file system and a fake command runner. No Docker, no real processes.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "./tools.mjs";
import { makeCodeStore } from "./guards.mjs";

// ---------- fakes ----------
// An in-memory repository: a map from path to text.
const fakeFs = (files) => ({
  files,
  exists: (p) => p in files || Object.keys(files).some((k) => k.startsWith(`${p}/`)),
  readText: (p) => { if (!(p in files)) throw new Error(`no such file: ${p}`); return files[p]; },
  listDir: (p) => {
    const seen = new Map();
    for (const k of Object.keys(files)) {
      if (!k.startsWith(`${p}/`)) continue;
      const rest = k.slice(p.length + 1), name = rest.split("/")[0];
      seen.set(name, { name, isFile: !rest.includes("/"), isDirectory: rest.includes("/") });
    }
    return [...seen.values()];
  },
});
const repo = () => ({
  "config/readiness.json": JSON.stringify({ workflowsDir: "workflows" }),
  "workflows/site-health-alert/workflow.json": '{"v":1}',
  "workflows/site-health-alert/tests/01-down.yaml": "test: down",
  "workflows/site-health-alert/tests/02-up.yaml": "test: up",
  "workflows/store-pickup-reminder/workflow.json": '{"v":1}',
  "workflows/store-pickup-reminder/tests/01.yaml": "test: one",
  "workflows/not-a-workflow/readme.txt": "no workflow.json here",
  "workflows/stray-file.txt": "x",
});
// A runner that records every call and answers from a queue of scripted results.
const fakeRunner = (...answers) => {
  const calls = [];
  const runCli = async (args, opts) => { calls.push({ args, opts }); return answers.shift() ?? { status: 0, out: "", timedOut: false }; };
  return { runCli, calls };
};
const build = ({ files = repo(), answers = [] } = {}) => {
  const fsx = fakeFs(files);
  const runner = fakeRunner(...answers);
  const codes = makeCodeStore({ random: (() => { let n = 100000; return () => n++; })() });
  const made = createTools({ fsx, runCli: runner.runCli, codes });
  const byName = Object.fromEntries(made.tools.map((t) => [t.name, t]));
  return { ...made, byName, fsx, calls: runner.calls, codes };
};

// What the command line prints with --json: one JSON object on standard output.
const say = (obj, status = 0) => ({ status, stdout: `${JSON.stringify(obj)}\n`, stderr: "", out: `${JSON.stringify(obj)}\n`, timedOut: false });
const PASSING = { allPass: true, workflow: "workflows/site-health-alert", scan: [], structure: [], tests: [{ name: "down alert", pass: true, checks: [] }] };
const FAILING = { allPass: false, workflow: "workflows/site-health-alert", scan: [], structure: [], tests: [{ name: "down alert", pass: false, checks: [{ assertion: 'node "Send alert" called 1 time', pass: false, detail: "called 0 time(s)" }] }] };

const STARTED = { state: "started", address: "http://127.0.0.1:5678", login: { email: "test@test.com", password: "Test1234" }, workflow: "workflows/site-health-alert" };
const CHANGES = [{ kind: "changed", node: "Compose alert", details: [{ label: "text", from: "ALERT: down", to: "TEST: down" }] }];
const FACTS = { workflow: "workflows/site-health-alert", changes: CHANGES, notApplied: [], notes: [], missing: [], conflicts: [], changedMeanwhile: false };
const STOPPED = { state: "saved", cleaned: true, summary: FACTS };

const BAD_NAMES = ["../etc", "..", "a/b", "a\\b", "/abs", "a b", "", "x;rm -rf", "a$(whoami)", "does-not-exist"];

// ---------- the tools as a set ----------
test("every tool has a name, a plain description, a strict schema and annotations", () => {
  const { tools } = build();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_workflow", "list_workflows", "pull_apply", "pull_preview", "status", "ui_start", "ui_stop"]);
  for (const t of tools) {
    assert.ok(t.description.length > 30, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(typeof t.handler, "function", t.name);
    assert.equal(t.annotations.openWorldHint, false, `${t.name} must say it does not reach the outside world`);
  }
});

test("only pull_apply is marked destructive, and the read-only ones are marked read-only", () => {
  const { tools } = build();
  assert.deepEqual(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name), ["pull_apply"]);
  assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort(),
    ["check_workflow", "list_workflows", "pull_preview", "status"]);
});

test("every tool that takes a workflow refuses bad names without running anything", async () => {
  const { byName, calls } = build();
  for (const tool of ["check_workflow", "ui_start", "pull_preview"]) {
    for (const workflow of BAD_NAMES) {
      const r = await byName[tool].handler({ workflow });
      assert.equal(r.isError, true, `${tool} accepted ${JSON.stringify(workflow)}`);
    }
  }
  for (const workflow of BAD_NAMES) assert.equal((await byName.pull_apply.handler({ workflow, code: "123456" })).isError, true);
  assert.equal(calls.length, 0, "a refused call must never reach the command line");
});

test("every tool rejects unexpected arguments without running anything", async () => {
  const { byName, calls } = build();
  assert.equal((await byName.check_workflow.handler({ workflow: "site-health-alert", flags: "--evil" })).isError, true);
  assert.equal((await byName.list_workflows.handler({ anything: 1 })).isError, true);
  assert.equal((await byName.status.handler({ x: 1 })).isError, true);
  assert.equal((await byName.ui_stop.handler({ x: 1 })).isError, true);
  assert.equal((await byName.check_workflow.handler({ workflow: ["a"] })).isError, true);
  assert.equal((await byName.check_workflow.handler("site-health-alert")).isError, true);
  assert.equal(calls.length, 0);
});

// ---------- list_workflows ----------
test("list_workflows lists real workflows with their test counts, and nothing else", async () => {
  const { byName } = build();
  const r = await byName.list_workflows.handler({});
  assert.equal(r.isError, false);
  assert.equal(r.text, "- site-health-alert (2 tests)\n- store-pickup-reminder (1 test)");
});

test("list_workflows follows the configured workflows folder and says so when it is empty", async () => {
  const { byName } = build({ files: { "config/readiness.json": JSON.stringify({ workflowsDir: "flows" }), "flows/x/workflow.json": "{}" } });
  assert.equal((await byName.list_workflows.handler({})).text, "- x (0 tests)");
  const empty = build({ files: { "config/readiness.json": "{}" } });
  assert.match((await empty.byName.list_workflows.handler({})).text, /no workflows in workflows\//);
});

// ---------- check_workflow ----------
test("check_workflow runs exactly the check command and answers in plain words", async () => {
  const { byName, calls } = build({ answers: [say(PASSING)] });
  const r = await byName.check_workflow.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, false);
  assert.match(r.text, /passed every check/);
  assert.deepEqual(calls[0].args, ["check", "workflows/site-health-alert", "--json"]);
  assert.equal(calls[0].opts.env.N8N_CMD, "./scripts/n8n-docker.sh");
  assert.ok(calls[0].opts.timeoutMs >= 5 * 60_000, "a first run pulls an image, so it needs a long timeout");
});

test("a failing check is a normal result with the report, not a tool error", async () => {
  const { byName, state } = build({ answers: [say(FAILING, 1)] });
  const r = await byName.check_workflow.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, false);
  assert.match(r.text, /isn't ready yet/);
  assert.match(r.text, /“Send alert” should have run 1 time but ran 0 time/);
  assert.equal(state.checks["site-health-alert"].passed, false);
});

test("a check that could not run at all is a tool error", async () => {
  const { byName, state } = build({ answers: [{ status: null, out: "Could not start n8n-dev", stdout: "", timedOut: false }] });
  const r = await byName.check_workflow.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Docker Desktop/);
  assert.equal(state.checks["site-health-alert"], undefined);
});

test("check_workflow remembers a passing check against the exact content, and the fingerprint moves when anything changes", async () => {
  const { byName, state, fsx, workflowHash } = build({ answers: [say(PASSING)] });
  await byName.check_workflow.handler({ workflow: "site-health-alert" });
  const remembered = state.checks["site-health-alert"];
  assert.equal(remembered.passed, true);
  assert.equal(remembered.hash, workflowHash("workflows/site-health-alert"));
  fsx.files["workflows/site-health-alert/workflow.json"] = '{"v":2}';                 // the workflow changes
  assert.notEqual(workflowHash("workflows/site-health-alert"), remembered.hash);
  fsx.files["workflows/site-health-alert/workflow.json"] = '{"v":1}';
  fsx.files["workflows/site-health-alert/tests/01-down.yaml"] = "test: changed";      // a test changes
  assert.notEqual(workflowHash("workflows/site-health-alert"), remembered.hash);
});

test("very long output is shortened", async () => {
  const long = { ...FAILING, tests: [{ name: "x".repeat(100_000), pass: false, checks: [] }] };
  const { byName } = build({ answers: [say(long, 1)] });
  const r = await byName.check_workflow.handler({ workflow: "site-health-alert" });
  assert.ok(r.text.length < 25_000);
  assert.match(r.text, /characters left out/);
});

// ---------- status ----------
test("status reports clean and leftovers as results, and 'could not tell' as an error", async () => {
  const a = build({ answers: [{ status: 0, out: "CLEAN: nothing" }] });
  assert.deepEqual(await a.byName.status.handler({}), { text: "No test editor is open.", isError: false });
  assert.deepEqual(a.calls[0].args, ["status"]);
  const b = build({ answers: [{ status: 1, out: "LEFTOVERS:" }] });
  const left = await b.byName.status.handler({});
  assert.equal(left.isError, false);
  assert.match(left.text, /still open/);
  const c = build({ answers: [{ status: 2, out: "UNKNOWN: Docker is not running" }] });
  assert.equal((await c.byName.status.handler({})).isError, true);
});

// ---------- ui_start / ui_stop ----------
test("ui_start runs ui --detach for the named workflow and returns the address and login", async () => {
  const { byName, calls, state } = build({ answers: [say(STARTED)] });
  const r = await byName.ui_start.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, false);
  assert.match(r.text, /http:\/\/127\.0\.0\.1:5678/);
  assert.match(r.text, /test@test\.com/);
  assert.deepEqual(calls[0].args, ["ui", "workflows/site-health-alert", "--detach", "--json"]);
  assert.equal(state.chamber, "site-health-alert");
});

test("ui_start passes a valid port and refuses an invalid one before anything runs", async () => {
  const ok = build({ answers: [say(STARTED)] });
  await ok.byName.ui_start.handler({ workflow: "site-health-alert", port: 8080 });
  assert.deepEqual(ok.calls[0].args, ["ui", "workflows/site-health-alert", "--detach", "--json", "--port", "8080"]);
  const bad = build();
  for (const port of [80, 70000, "80; rm -rf", -1, 1.5, {}]) {
    assert.equal((await bad.byName.ui_start.handler({ workflow: "site-health-alert", port })).isError, true, JSON.stringify(port));
  }
  assert.equal(bad.calls.length, 0);
});

test("ui_start relays a refusal when a chamber is already running, and records nothing", async () => {
  const { byName, state } = build({ answers: [say({ state: "already-running" }, 1)] });
  const r = await byName.ui_start.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, true);
  assert.match(r.text, /already open/);
  assert.equal(state.chamber, null);
});

test("ui_start says what went wrong in plain words when it did not start", async () => {
  const { byName, state } = build({ answers: [say({ state: "failed", message: "x", details: "docker: not found" }, 1)] });
  const r = await byName.ui_start.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Docker Desktop/);
  assert.equal(state.chamber, null);
  const silent = build({ answers: [{ status: 1, stdout: "", out: "boom", timedOut: false }] });
  assert.equal((await silent.byName.ui_start.handler({ workflow: "site-health-alert" })).isError, true);
});

test("ui_stop runs ui-stop, says what the person changed, and clears the open chamber", async () => {
  const { byName, calls, state } = build({ answers: [say(STOPPED)] });
  state.chamber = "site-health-alert";
  const r = await byName.ui_stop.handler({});
  assert.equal(r.isError, false);
  assert.deepEqual(calls.at(-1).args, ["ui-stop", "--json"]);
  assert.match(r.text, /In “Compose alert”, the text changed from “ALERT: down” to “TEST: down”/);
  assert.equal(state.chamber, null);
});

test("ui_stop with no open session leaves a remembered chamber alone", async () => {
  const { byName, state } = build({ answers: [say({ state: "no-session" }, 2)] });
  state.chamber = "site-health-alert";
  const r = await byName.ui_stop.handler({});
  assert.match(r.text, /no test editor session/i);
  assert.equal(state.chamber, "site-health-alert");
});

// ---------- pull_preview / pull_apply ----------
const PREVIEW_WITH_CHANGES = say({ state: "ready", ...FACTS });
const APPLIED = say({ state: "applied", ...FACTS });
const withSession = () => ({ ...repo(), ".n8n-dev/ui-manifest.json": '{"m":1}', ".n8n-dev/ui-export/a.json": '{"e":1}' });

test("pull_preview runs a dry run and issues a one-time code only when there is something to apply", async () => {
  const { byName, calls } = build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES] });
  const r = await byName.pull_preview.handler({ workflow: "site-health-alert" });
  assert.deepEqual(calls[0].args, ["pull", "workflows/site-health-alert", "--json"]);
  assert.match(r.text, /code 1000\d\d/);
  assert.match(r.text, /Nothing has been changed yet/);
  assert.match(r.text, /changed from “ALERT: down” to “TEST: down”/);
  assert.ok(!calls[0].args.includes("--apply"));
});

test("pull_preview issues no code when nothing changed, when it is refused, or when it errors", async () => {
  for (const answer of [
    say({ state: "nothing", ...FACTS, changes: [] }),
    say({ state: "blocked", reason: "changed-meanwhile", ...FACTS }, 1),
    say({ state: "blocked", reason: "conflict", ...FACTS }, 1),
    say({ state: "blocked", reason: "scan", findings: [{ node: "Send alert", rule: "secret" }], ...FACTS }, 1),
  ]) {
    const { byName } = build({ files: withSession(), answers: [answer] });
    const r = await byName.pull_preview.handler({ workflow: "site-health-alert" });
    assert.doesNotMatch(r.text, /code \d{6}/, answer.stdout);
  }
  const broke = build({ files: withSession(), answers: [say({ state: "no-session" }, 2)] });
  assert.equal((await broke.byName.pull_preview.handler({ workflow: "site-health-alert" })).isError, true);
  const garbled = build({ files: withSession(), answers: [{ status: 1, stdout: "not json", out: "not json" }] });
  assert.equal((await garbled.byName.pull_preview.handler({ workflow: "site-health-alert" })).isError, true);
});

test("a refused or empty preview does not even create a code behind the scenes", async () => {
  const ctx = build({ files: withSession(), answers: [
    say({ state: "nothing", ...FACTS, changes: [] }),
    say({ state: "blocked", reason: "scan", findings: [], ...FACTS }, 1),
    PREVIEW_WITH_CHANGES,
  ] });
  await ctx.byName.pull_preview.handler({ workflow: "site-health-alert" });
  await ctx.byName.pull_preview.handler({ workflow: "site-health-alert" });
  const r = await ctx.byName.pull_preview.handler({ workflow: "site-health-alert" });
  assert.match(r.text, /code 100000\b/, "the first code ever issued, so the earlier previews issued none");
});

const previewThenCode = async (ctx) => {
  const r = await ctx.byName.pull_preview.handler({ workflow: "site-health-alert" });
  return r.text.match(/code (\d{6})/)[1];
};

test("pull_apply with the right code runs the apply, then forgets the old check", async () => {
  const ctx = build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES, APPLIED] });
  ctx.state.checks["site-health-alert"] = { passed: true, hash: "old" };
  const code = await previewThenCode(ctx);
  const r = await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code });
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls.at(-1).args, ["pull", "workflows/site-health-alert", "--apply", "--json"]);
  assert.match(r.text, /Done\. Your change is now in the workflow/);
  assert.match(r.text, /check_workflow/);
  assert.equal(ctx.state.checks["site-health-alert"], undefined);
});

test("pull_apply without a preview, or with a wrong code, runs nothing", async () => {
  const ctx = build({ files: withSession() });
  for (const code of ["123456", "", "abc", "000000"]) {
    assert.equal((await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code })).isError, true, code);
  }
  assert.equal(ctx.calls.length, 0);
});

test("a code works once: replaying it is refused and does not run again", async () => {
  const ctx = build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES, APPLIED] });
  const code = await previewThenCode(ctx);
  await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code });
  const callsAfterFirst = ctx.calls.length;
  const again = await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code });
  assert.equal(again.isError, true);
  assert.equal(ctx.calls.length, callsAfterFirst);
});

test("if the workflow file changes after the preview, the code no longer works", async () => {
  const ctx = build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES] });
  const code = await previewThenCode(ctx);
  ctx.fsx.files["workflows/site-health-alert/workflow.json"] = '{"v":"someone edited it"}';
  const r = await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code });
  assert.equal(r.isError, true);
  assert.equal(ctx.calls.length, 1, "only the preview ran");
});

test("if the saved edits change after the preview, the code no longer works", async () => {
  const ctx = build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES] });
  const code = await previewThenCode(ctx);
  ctx.fsx.files[".n8n-dev/ui-export/a.json"] = '{"e":"different edits"}';
  assert.equal((await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code })).isError, true);
  assert.equal(ctx.calls.length, 1);
});

test("a code for one workflow cannot apply another", async () => {
  const ctx = build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES] });
  const code = await previewThenCode(ctx);
  assert.equal((await ctx.byName.pull_apply.handler({ workflow: "store-pickup-reminder", code })).isError, true);
  assert.equal(ctx.calls.length, 1);
});

test("a failed apply is an error and keeps the earlier check", async () => {
  const ctx = build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES, say({ state: "blocked", reason: "scan", findings: [{ node: "Send alert", rule: "secret" }], ...FACTS }, 1)] });
  ctx.state.checks["site-health-alert"] = { passed: true, hash: "keep" };
  const code = await previewThenCode(ctx);
  const r = await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code });
  assert.equal(r.isError, true);
  assert.match(r.text, /unsafe/);
  assert.equal(ctx.state.checks["site-health-alert"].hash, "keep");
});
