// Unit tests for mcp/tools.mjs, using a fake file system and a fake command runner. No Docker, no real processes.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createTools, MIN_OPEN_MS } from "./tools.mjs";
import { makeCodeStore, hashOf } from "./guards.mjs";

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
const build = ({ files = repo(), answers = [], clock = { t: 1_000_000 } } = {}) => {
  const fsx = fakeFs(files);
  const runner = fakeRunner(...answers);
  const codes = makeCodeStore({ random: (() => { let n = 100000; return () => n++; })() });
  const made = createTools({ fsx, runCli: runner.runCli, codes, now: () => clock.t });
  const byName = Object.fromEntries(made.tools.map((t) => [t.name, t]));
  return { ...made, byName, fsx, calls: runner.calls, codes, clock };
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_workflow", "explain_test_failures", "list_workflows", "pull_apply", "pull_preview", "status", "submit_preview", "ui_start", "ui_stop", "undo_change", "update_tests"]);
  for (const t of tools) {
    assert.ok(t.description.length > 30, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(typeof t.handler, "function", t.name);
    assert.equal(t.annotations.openWorldHint, false, `${t.name} must say it does not reach the outside world`);
  }
});

test("only pull_apply, update_tests and undo_change are marked destructive, and the read-only ones are marked read-only", () => {
  const { tools } = build();
  assert.deepEqual(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort(), ["pull_apply", "undo_change", "update_tests"]);
  assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort(),
    ["check_workflow", "explain_test_failures", "list_workflows", "pull_preview", "status", "submit_preview"]);
});

test("every tool that takes a workflow refuses bad names without running anything", async () => {
  const { byName, calls } = build();
  for (const tool of ["check_workflow", "ui_start", "pull_preview", "explain_test_failures", "submit_preview"]) {
    for (const workflow of BAD_NAMES) {
      const r = await byName[tool].handler({ workflow });
      assert.equal(r.isError, true, `${tool} accepted ${JSON.stringify(workflow)}`);
    }
  }
  for (const workflow of BAD_NAMES) for (const t of ["pull_apply", "update_tests"]) assert.equal((await byName[t].handler({ workflow, code: "123456" })).isError, true);
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
  const r = await byName.ui_stop.handler({ theirWords: "I am done" });
  assert.equal(r.isError, false);
  assert.deepEqual(calls.at(-1).args, ["ui-stop", "--json"]);
  assert.match(r.text, /In “Compose alert”, the text changed from “ALERT: down” to “TEST: down”/);
  assert.equal(state.chamber, null);
});

test("ui_stop with no open session leaves a remembered chamber alone", async () => {
  const { byName, state } = build({ answers: [say({ state: "no-session" }, 2)] });
  state.chamber = "site-health-alert";
  const r = await byName.ui_stop.handler({ theirWords: "I am done" });
  assert.match(r.text, /no test editor session/i);
  assert.equal(state.chamber, "site-health-alert");
});

// ---------- closing the editor is the person's decision ----------
const STOP_DONE = say({ state: "saved", cleaned: true, summary: { ...FACTS, changes: [] } });

test("ui_stop right after ui_start is refused and never reaches the command line", async () => {
  const ctx = build({ answers: [say(STARTED), STOP_DONE] });
  await ctx.byName.ui_start.handler({ workflow: "site-health-alert" });
  ctx.clock.t += 3_000;                                                  // the assistant calls it seconds later
  const r = await ctx.byName.ui_stop.handler({ theirWords: "I am done" });
  assert.equal(r.isError, true);
  assert.match(r.text, /only just opened/);
  assert.equal(ctx.calls.length, 1, "only the start ran");
  assert.equal(ctx.state.chamber, "site-health-alert", "the editor is still considered open");
});

test("control: after enough time, with the person's words, ui_stop does run", async () => {
  const ctx = build({ answers: [say(STARTED), STOP_DONE] });
  await ctx.byName.ui_start.handler({ workflow: "site-health-alert" });
  ctx.clock.t += MIN_OPEN_MS;
  const r = await ctx.byName.ui_stop.handler({ theirWords: "I'm done" });
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls.at(-1).args, ["ui-stop", "--json"]);
  assert.equal(ctx.state.chamber, null);
  assert.equal(ctx.state.openedAt, null);
});

test("ui_stop without the person's words is refused and runs nothing", async () => {
  for (const args of [{}, { theirWords: "" }, { theirWords: "   " }, { theirWords: "x".repeat(201) }, { theirWords: 5 }, { theirWords: "ok", extra: 1 }]) {
    const ctx = build({ answers: [STOP_DONE] });
    const r = await ctx.byName.ui_stop.handler(args);
    assert.equal(r.isError, true, JSON.stringify(args).slice(0, 40));
    assert.equal(ctx.calls.length, 0);
  }
});

test("an editor left open from an earlier session can still be closed with the person's words", async () => {
  const ctx = build({ answers: [STOP_DONE] });                           // this server run never started it, so there is no start time
  const r = await ctx.byName.ui_stop.handler({ theirWords: "I'm done" });
  assert.equal(r.isError, false);
  assert.equal(ctx.calls.length, 1);
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

// ---------- undo_change ----------
const RESTORED = say({ state: "restored", workflow: "workflows/site-health-alert", changes: CHANGES, at: "2026-10-18T00:00:00Z" });

test("undo_change runs undo, says what was taken back, and forgets every earlier check", async () => {
  const ctx = build({ answers: [RESTORED] });
  ctx.state.checks["site-health-alert"] = { passed: true, hash: "x" };
  const r = await ctx.byName.undo_change.handler({ theirWords: "please go back" });
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls[0].args, ["undo", "--json"]);
  assert.match(r.text, /back to “ALERT: down” \(it had been changed to “TEST: down”\)/);
  assert.deepEqual(ctx.state.checks, {});
});

test("undo_change without the person's words, or with extra arguments, runs nothing", async () => {
  for (const args of [{}, { theirWords: "" }, { theirWords: "  " }, { theirWords: "x".repeat(201) }, { theirWords: "ok", file: "../x" }]) {
    const ctx = build({ answers: [RESTORED] });
    assert.equal((await ctx.byName.undo_change.handler(args)).isError, true, JSON.stringify(args).slice(0, 40));
    assert.equal(ctx.calls.length, 0);
  }
});

test("undo_change explains each way it can be refused, and keeps earlier checks when nothing was undone", async () => {
  for (const state of ["nothing-to-undo", "already-undone", "changed-since", "missing", "write-failed"]) {
    const ctx = build({ answers: [say({ state }, 1)] });
    ctx.state.checks.w = { passed: true, hash: "keep" };
    const r = await ctx.byName.undo_change.handler({ theirWords: "undo it" });
    assert.ok(r.text.length > 20, state);
    assert.equal(ctx.state.checks.w.hash, "keep", state);
  }
  const garbled = build({ answers: [{ status: 1, stdout: "nope", out: "nope" }] });
  assert.equal((await garbled.byName.undo_change.handler({ theirWords: "undo" })).isError, true);
});

// ---------- explain_test_failures / update_tests ----------
const UPDATE = { test: "Down site sends an alert", file: "01.yaml", from: "ALERT: docs is not healthy", to: "OLALA: docs is not healthy" };
const FIX_READY = say({ state: "ready", workflow: "workflows/site-health-alert", updates: [UPDATE], unexplained: [] });
const FIX_APPLIED = say({ state: "applied", workflow: "workflows/site-health-alert", updates: [UPDATE], unexplained: [] });
const withApply = () => ({ ...repo(), ".n8n-dev/last-apply.json": '{"r":1}' });
const UNEXPLAINED = say({ state: "unexplained", unexplained: [{ test: "Down", reason: "unrelated", assertion: 'node "Send alert" called 1 time', detail: "called 0 time(s)" }] }, 1);

test("explain_test_failures asks for a dry run, shows the old and new wording, and issues a code only when there is something to update", async () => {
  const ctx = build({ files: withApply(), answers: [FIX_READY] });
  const r = await ctx.byName.explain_test_failures.handler({ workflow: "site-health-alert" });
  assert.deepEqual(ctx.calls[0].args, ["tests-fix", "workflows/site-health-alert", "--json"]);
  assert.match(r.text, /currently expects “ALERT: docs is not healthy”. It would expect “OLALA: docs is not healthy”/);
  assert.match(r.text, /Did you mean to change that on purpose/);
  assert.match(r.text, /code 1000\d\d/);
});

test("explain_test_failures issues no code, and offers a colleague, when nothing can be safely updated", async () => {
  for (const answer of [
    UNEXPLAINED,
    say({ state: "nothing", updates: [], unexplained: [] }),
    say({ state: "no-change" }, 1),
    say({ state: "wrong-workflow", expected: "a", given: "b" }, 2),
  ]) {
    const ctx = build({ files: withApply(), answers: [answer] });
    const r = await ctx.byName.explain_test_failures.handler({ workflow: "site-health-alert" });
    assert.doesNotMatch(r.text, /code \d{6}/, answer.stdout);
  }
  const unexplained = build({ files: withApply(), answers: [UNEXPLAINED] });
  assert.match((await unexplained.byName.explain_test_failures.handler({ workflow: "site-health-alert" })).text, /someone who knows the tests/);
  const garbled = build({ files: withApply(), answers: [{ status: 1, stdout: "no json", out: "no json" }] });
  assert.equal((await garbled.byName.explain_test_failures.handler({ workflow: "site-health-alert" })).isError, true);
});

const explainThenCode = async (ctx) => (await ctx.byName.explain_test_failures.handler({ workflow: "site-health-alert" })).text.match(/code (\d{6})/)[1];

test("update_tests with the right code applies, says what the tests now expect, and forgets the old check", async () => {
  const ctx = build({ files: withApply(), answers: [FIX_READY, FIX_APPLIED] });
  ctx.state.checks["site-health-alert"] = { passed: false, hash: "old" };
  const code = await explainThenCode(ctx);
  const r = await ctx.byName.update_tests.handler({ workflow: "site-health-alert", code });
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls.at(-1).args, ["tests-fix", "workflows/site-health-alert", "--apply", "--json"]);
  assert.match(r.text, /now expects “OLALA: docs is not healthy” \(it used to expect “ALERT: docs is not healthy”\)/);
  assert.equal(ctx.state.checks["site-health-alert"], undefined);
});

test("update_tests without a code, with a wrong code, or replayed, runs nothing", async () => {
  const ctx = build({ files: withApply(), answers: [FIX_READY, FIX_APPLIED] });
  for (const code of ["123456", "", "abc"]) assert.equal((await ctx.byName.update_tests.handler({ workflow: "site-health-alert", code })).isError, true, code);
  assert.equal(ctx.calls.length, 0);
  const code = await explainThenCode(ctx);
  await ctx.byName.update_tests.handler({ workflow: "site-health-alert", code });
  const after = ctx.calls.length;
  assert.equal((await ctx.byName.update_tests.handler({ workflow: "site-health-alert", code })).isError, true);
  assert.equal(ctx.calls.length, after);
});

test("a code for updating tests stops working if the workflow, a test, or the record of the apply changes", async () => {
  for (const change of [
    (f) => { f["workflows/site-health-alert/workflow.json"] = '{"v":"edited"}'; },
    (f) => { f["workflows/site-health-alert/tests/01-down.yaml"] = "test: edited"; },
    (f) => { f[".n8n-dev/last-apply.json"] = '{"r":2}'; },
  ]) {
    const ctx = build({ files: withApply(), answers: [FIX_READY, FIX_APPLIED] });
    const code = await explainThenCode(ctx);
    change(ctx.fsx.files);
    assert.equal((await ctx.byName.update_tests.handler({ workflow: "site-health-alert", code })).isError, true);
    assert.equal(ctx.calls.length, 1, "only the dry run ran");
  }
});

test("a code from the pull preview cannot be used to update tests, and the other way round", async () => {
  const ctx = build({ files: { ...withApply(), ".n8n-dev/ui-manifest.json": '{"m":1}', ".n8n-dev/ui-export/a.json": '{"e":1}' }, answers: [PREVIEW_WITH_CHANGES, FIX_READY] });
  const pullCode = (await ctx.byName.pull_preview.handler({ workflow: "site-health-alert" })).text.match(/code (\d{6})/)[1];
  assert.equal((await ctx.byName.update_tests.handler({ workflow: "site-health-alert", code: pullCode })).isError, true);
  const testCode = await explainThenCode(ctx);
  assert.equal((await ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code: testCode })).isError, true);
});

test("an explanation with nothing to update does not even create a code behind the scenes", async () => {
  const ctx = build({ files: withApply(), answers: [UNEXPLAINED, say({ state: "nothing", updates: [], unexplained: [] }), FIX_READY] });
  await ctx.byName.explain_test_failures.handler({ workflow: "site-health-alert" });
  await ctx.byName.explain_test_failures.handler({ workflow: "site-health-alert" });
  const r = await ctx.byName.explain_test_failures.handler({ workflow: "site-health-alert" });
  assert.match(r.text, /code 100000\b/, "the first code ever issued, so the earlier answers issued none");
});

// ---------- submit_preview ----------
const FILES = [{ path: "workflows/site-health-alert/workflow.json", status: "M" }, { path: "workflows/site-health-alert/tests/01-down.yaml", status: "M" }];
const SUBMIT_FACTS = (over = {}) => say({
  state: "facts", base: "origin/main", dir: "workflows/site-health-alert", files: FILES, workflowChanged: true, newWorkflow: false,
  workflowChanges: CHANGES, tests: [{ path: FILES[1].path, status: "M", name: "Down site sends an alert" }], ...over,
});
const CLEAN = { status: 0, stdout: "CLEAN", out: "CLEAN", timedOut: false };
// a context in which the check has passed on exactly the current content
const checked = (answers) => {
  const ctx = build({ files: repo(), answers });
  ctx.state.checks["site-health-alert"] = { passed: true, hash: ctx.workflowHash("workflows/site-health-alert") };
  return ctx;
};
const preview = (ctx, extra = {}) => ctx.byName.submit_preview.handler({ workflow: "site-health-alert", ...extra });

test("submit_preview shows what would go, in plain words, sends nothing, and issues a one-time code", async () => {
  const ctx = checked([CLEAN, SUBMIT_FACTS()]);
  const r = await preview(ctx);
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls.map((c) => c.args[0]), ["status", "submit-facts"]);
  assert.deepEqual(ctx.calls[1].args, ["submit-facts", "workflows/site-health-alert", "--json"]);
  assert.match(r.text, /Everything is in order to send this for review/);
  assert.match(r.text, /changed from “ALERT: down” to “TEST: down”/);
  assert.match(r.text, /The test “Down site sends an alert” was changed/);
  assert.match(r.text, /Because tests were changed, a technical reviewer/);
  assert.match(r.text, /Nothing has been sent yet/);
  assert.match(r.text, /code 1000\d\d|is 1000\d\d/);
});

test("submit_preview refuses, and issues no code, for each missing piece of evidence", async () => {
  const cases = [
    [() => build({ answers: [CLEAN, SUBMIT_FACTS()] }), /haven't checked this version/],
    [() => { const c = checked([CLEAN, SUBMIT_FACTS()]); c.state.checks["site-health-alert"].hash = "older"; return c; }, /need to check again/],
    [() => { const c = checked([CLEAN, SUBMIT_FACTS()]); c.state.checks["site-health-alert"].passed = false; return c; }, /latest check failed/],
    [() => checked([{ status: 1, stdout: "LEFTOVERS", out: "LEFTOVERS", timedOut: false }, SUBMIT_FACTS()]), /still open/],
    [() => checked([{ status: 2, stdout: "UNKNOWN", out: "UNKNOWN", timedOut: false }, SUBMIT_FACTS()]), /Docker Desktop/],
    [() => checked([CLEAN, SUBMIT_FACTS({ files: [], workflowChanged: false })]), /nothing different/],
    [() => checked([CLEAN, SUBMIT_FACTS({ files: [...FILES, { path: "workflows/site-health-alert/notes.txt", status: "A" }] })]), /1 other file changed/],
    [() => checked([CLEAN, SUBMIT_FACTS({ files: [FILES[0]], tests: [] })]), /no test goes with it/],
    [() => checked([CLEAN, say({ state: "no-git" }, 2)]), /isn't installed/],
    [() => checked([CLEAN, say({ state: "no-base" }, 2)]), /shared version/],
    [() => checked([CLEAN, { status: 1, stdout: "garbage", out: "garbage" }]), /couldn't work out/],
  ];
  for (const [make, expected] of cases) {
    const ctx = make();
    const r = await preview(ctx);
    assert.match(r.text, expected);
    assert.doesNotMatch(r.text, /code \d{6}|is \d{6}/, expected.source);
  }
  // none of those cases created a code behind the scenes either: in one context, refusals first, then a ready one
  const shared = checked([CLEAN, SUBMIT_FACTS({ files: [], workflowChanged: false }), CLEAN, say({ state: "no-base" }, 2), CLEAN, SUBMIT_FACTS()]);
  await preview(shared);
  await preview(shared);
  assert.match((await preview(shared)).text, /100000\b/, "the first code ever issued, so the refusals issued none");
});

test("a workflow change with no test goes through only with the person's reason, which is shown back", async () => {
  const noTest = () => SUBMIT_FACTS({ files: [FILES[0]], tests: [] });
  const ctx = checked([CLEAN, noTest(), CLEAN, noTest()]);
  assert.match((await preview(ctx)).text, /tell me why/);
  const r = await preview(ctx, { reason: "Only a typo in a label" });
  assert.match(r.text, /No test changed\. You told me why: “Only a typo in a label”/);
  assert.doesNotMatch(r.text, /technical reviewer will look at those closely/);
});

test("the code is tied to the exact files and reason: a different list gives a code that cannot stand in for the first", async () => {
  const more = SUBMIT_FACTS({ files: [...FILES, { path: "workflows/site-health-alert/tests/02-up.yaml", status: "A" }] });
  const ctx = checked([CLEAN, SUBMIT_FACTS(), CLEAN, more]);
  const first = (await preview(ctx)).text.match(/is (\d{6})/)[1];
  const second = (await preview(ctx)).text.match(/is (\d{6})/)[1];
  assert.notEqual(first, second);
  // the code can be checked against what it was issued for: right for the first list, wrong for any other
  const key = (files, reason) => `submit:site-health-alert:${hashOf({ content: ctx.workflowHash("workflows/site-health-alert"), files, reason })}`;
  assert.equal(ctx.codes.redeem(first, key(more.stdout ? JSON.parse(more.stdout).files : [], null)).ok, false, "wrong file list");
  assert.equal(ctx.codes.redeem(first, key(FILES, "a different reason")).ok, false, "wrong reason");
  assert.equal(ctx.codes.redeem(first, key(FILES, null)).ok, true, "the exact files and reason it was issued for");
});

test("submit_preview rejects unexpected arguments and bad reasons before running anything", async () => {
  const ctx = build();
  for (const args of [{ workflow: "site-health-alert", reason: 5 }, { workflow: "site-health-alert", branch: "main" }, { workflow: "site-health-alert", reason: ["x"] }]) {
    assert.equal((await ctx.byName.submit_preview.handler(args)).isError, true, JSON.stringify(args));
  }
  assert.equal(ctx.calls.length, 0);
});
