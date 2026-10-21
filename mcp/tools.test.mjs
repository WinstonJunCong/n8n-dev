// Unit tests for mcp/tools.mjs, using a fake file system and a fake command runner. No Docker, no real processes.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createTools, MIN_OPEN_MS, MIN_CONFIRM_MS } from "./tools.mjs";
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
  const codes = makeCodeStore({ now: () => clock.t, random: (() => { let n = 100000; return () => n++; })() });
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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_workflow", "describe_workflow", "draft_test_preview", "draft_test_remove", "draft_test_save", "explain_test_failures", "list_workflows", "pull_apply", "pull_preview", "status", "submit", "submit_preview", "ui_discard", "ui_resume", "ui_start", "ui_stop", "undo_change", "update_tests"]);
  for (const t of tools) {
    assert.ok(t.description.length > 30, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.equal(typeof t.handler, "function", t.name);
    assert.equal(t.annotations.openWorldHint, ["submit", "submit_preview"].includes(t.name), `${t.name}: only the two that talk to the team repository may say they reach outside`);
  }
});

test("only pull_apply, update_tests, ui_discard, draft_test_remove and undo_change are marked destructive, and the read-only ones are marked read-only", () => {
  const { tools } = build();
  assert.deepEqual(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort(), ["draft_test_remove", "pull_apply", "ui_discard", "undo_change", "update_tests"]);
  assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort(),
    ["check_workflow", "describe_workflow", "draft_test_preview", "explain_test_failures", "list_workflows", "pull_preview", "status", "submit_preview"]);
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
  for (const workflow of BAD_NAMES) assert.equal((await byName.submit.handler({ workflow, code: "123456", theirWords: "yes" })).isError, true, `submit accepted ${JSON.stringify(workflow)}`);
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
const SESSION = (over) => say({ kind: "none", workflow: null, drift: null, changes: null, ageMs: null, age: null, stale: false, ...over });

test("status asks for the session report and says what, if anything, is left over from earlier", async () => {
  const none = build({ answers: [SESSION()] });
  assert.deepEqual(await none.byName.status.handler({}), { text: "No test editor is open, and nothing is waiting from earlier.", isError: false });
  assert.deepEqual(none.calls[0].args, ["session", "--json"]);
  const unknown = await build({ answers: [SESSION({ kind: "unknown" })] }).byName.status.handler({});
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Docker Desktop/);
});

test("status falls back to the plain yes/no when the session report cannot be read", async () => {
  const garbled = { status: 1, stdout: "not json", out: "not json" };
  const clean = build({ answers: [garbled, { status: 0, out: "CLEAN: nothing" }] });
  assert.equal((await clean.byName.status.handler({})).text, "No test editor is open.");
  assert.deepEqual(clean.calls.map((c) => c.args[0]), ["session", "status"]);
  const left = await build({ answers: [garbled, { status: 1, out: "LEFTOVERS:" }] }).byName.status.handler({});
  assert.match(left.text, /still open/);
  assert.equal((await build({ answers: [garbled, { status: 2, out: "UNKNOWN: Docker is not running" }] }).byName.status.handler({})).isError, true);
});

const stoppedSession = (over) => ({ kind: "editor-stopped", workflow: "workflows/site-health-alert", drift: false, changes: 2, ageMs: 5 * 3600_000, age: "about 5 hours ago", stale: false, ...over });

test("status offers the choices for each thing an earlier session can leave, with its age", async () => {
  const stopped = (await build({ answers: [SESSION(stoppedSession())] }).byName.status.handler({})).text;
  assert.match(stopped, /A test editor from about 5 hours ago was stopped \(probably by a restart\), but your changes are still safe in it/);
  assert.match(stopped, /bring it back so you can carry on, close it and keep your changes, or throw it away/);
  assert.match(stopped, /For you, the assistant.*ui_resume.*ui_stop.*ui_discard/s);
  const running = (await build({ answers: [SESSION(stoppedSession({ kind: "editor-running" }))] }).byName.status.handler({})).text;
  assert.match(running, /is still open, with your changes in it/);
  const saved = (await build({ answers: [SESSION(stoppedSession({ kind: "saved-edits", changes: 1 }))] }).byName.status.handler({})).text;
  assert.match(saved, /1 change from about 5 hours ago that were saved when the editor closed but never applied/);
  assert.match(saved, /show you what they are, or throw them away/);
  assert.match(saved, /pull_preview/);
});

test("old leftovers are described as old, and a workflow that moved on removes the offer to carry on", async () => {
  const old = (await build({ answers: [SESSION(stoppedSession({ stale: true, age: "5 days ago" }))] }).byName.status.handler({})).text;
  assert.match(old, /may be out of date\. Throwing it away is usually the safe choice/);
  const drift = (await build({ answers: [SESSION(stoppedSession({ drift: true }))] }).byName.status.handler({})).text;
  assert.match(drift, /workflow has changed since then/);
  assert.doesNotMatch(drift, /bring it back so you can carry on/);
  assert.doesNotMatch(drift, /ui_resume/);
  const driftSaved = (await build({ answers: [SESSION(stoppedSession({ kind: "saved-edits", drift: true }))] }).byName.status.handler({})).text;
  assert.match(driftSaved, /I can throw them away\./);
  assert.doesNotMatch(driftSaved, /show you what they are/);
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
  assert.deepEqual(ctx.calls[1].args, ["submit-facts", "workflows/site-health-alert", "--fetch", "--json"]);
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

// ---------- submit (the send step) ----------
const SENT = say({ state: "sent", workflow: "workflows/site-health-alert", branch: "n8n-dev/site-health-alert-19700101-0016", base: "origin/main", commit: "abc123", remoteUrl: "https://github.com/acme/flows.git" });
const SEND_WORDS = "Yes, please send it";
// answers for: preview (status, facts) then submit (status, facts, send)
const sendContext = (extra = []) => checked([CLEAN, SUBMIT_FACTS(), CLEAN, SUBMIT_FACTS(), SENT, ...extra]);
const previewCode = async (ctx) => (await preview(ctx)).text.match(/is (\d{6})/)[1];
const submit = (ctx, code, over = {}) => ctx.byName.submit.handler({ workflow: "site-health-alert", code, theirWords: SEND_WORDS, ...over });
const sendCalls = (ctx) => ctx.calls.filter((c) => c.args[0] === "submit");

test("submit sends the previewed change once the person has had time to read it, and gives the review link", async () => {
  const ctx = sendContext();
  const code = await previewCode(ctx);
  ctx.clock.t += MIN_CONFIRM_MS;
  const r = await submit(ctx, code);
  assert.equal(r.isError, false);
  assert.match(r.text, /Sent for review\. It is not live/);
  assert.match(r.text, /https:\/\/github\.com\/acme\/flows\/pull\/new\/n8n-dev\/site-health-alert-19700101-0016/);
  const [send] = sendCalls(ctx);
  assert.deepEqual(send.args.slice(0, 5), ["submit", "workflows/site-health-alert", "--branch", "n8n-dev/site-health-alert-19700101-0016", "--message"]);
  assert.match(send.args[5], /^Update site-health-alert/);
  assert.ok(ctx.calls.filter((c) => c.args[0] === "submit-facts").every((c) => c.args.includes("--fetch")), "it refreshes from the team repository before deciding");
});

test("submit is refused, and sends nothing, when the person has not had time to read the preview or was never shown one", async () => {
  const quick = sendContext();
  const code = await previewCode(quick);
  quick.clock.t += MIN_CONFIRM_MS - 1;
  assert.match((await submit(quick, code)).text, /go-ahead first/);
  assert.equal(sendCalls(quick).length, 0);

  const never = sendContext();
  assert.equal((await submit(never, "123456")).isError, true);
  assert.equal(never.calls.length, 0);
});

test("submit needs the person's own words", async () => {
  for (const theirWords of ["", "   ", "x".repeat(201)]) {
    const ctx = sendContext();
    const code = await previewCode(ctx);
    ctx.clock.t += MIN_CONFIRM_MS;
    const before = ctx.calls.length;
    const r = await submit(ctx, code, { theirWords });
    assert.equal(r.isError, true);
    assert.equal(ctx.calls.length, before, "nothing ran");
  }
  const ctx = sendContext();
  assert.equal((await ctx.byName.submit.handler({ workflow: "site-health-alert", code: "123456" })).isError, true);
});

test("submit refuses a wrong code and a replayed code, and never lets the assistant choose the branch or the message", async () => {
  // answers: the preview, the attempt with the wrong code, then the real send
  const ctx = checked([CLEAN, SUBMIT_FACTS(), CLEAN, SUBMIT_FACTS(), CLEAN, SUBMIT_FACTS(), SENT]);
  const code = await previewCode(ctx);
  ctx.clock.t += MIN_CONFIRM_MS;
  assert.equal((await submit(ctx, "000000")).isError, true);
  assert.equal(sendCalls(ctx).length, 0);
  assert.equal((await submit(ctx, code, { branch: "main" })).isError, true, "an unknown argument is refused");
  assert.equal((await submit(ctx, code, { message: "x" })).isError, true);
  assert.equal(sendCalls(ctx).length, 0);
  assert.equal((await submit(ctx, code)).isError, false);
  const again = await submit(ctx, code);
  assert.equal(again.isError, true);
  assert.equal(sendCalls(ctx).length, 1, "a code works once");
});

test("everything is checked again at the moment of sending: a change since the preview stops it", async () => {
  const stale = sendContext();
  const code = await previewCode(stale);
  stale.clock.t += MIN_CONFIRM_MS;
  stale.fsx.files["workflows/site-health-alert/workflow.json"] = '{"v":"edited after the preview"}';
  assert.match((await submit(stale, code)).text, /check again/);
  assert.equal(sendCalls(stale).length, 0);

  const opened = checked([CLEAN, SUBMIT_FACTS(), { status: 1, stdout: "LEFTOVERS", out: "LEFTOVERS", timedOut: false }, SUBMIT_FACTS(), SENT]);
  const code2 = await previewCode(opened);
  opened.clock.t += MIN_CONFIRM_MS;
  assert.match((await submit(opened, code2)).text, /still open/);
  assert.equal(sendCalls(opened).length, 0);

  const moved = checked([CLEAN, SUBMIT_FACTS(), CLEAN, SUBMIT_FACTS({ files: [...FILES, { path: "workflows/site-health-alert/tests/02-up.yaml", status: "A" }] }), SENT]);
  const code3 = await previewCode(moved);
  moved.clock.t += MIN_CONFIRM_MS;
  assert.equal((await submit(moved, code3)).isError, true, "a different list of files is a different preview");
  assert.equal(sendCalls(moved).length, 0);
});

test("a failed push is explained plainly, and a later submit is not blocked by it", async () => {
  const ctx = checked([CLEAN, SUBMIT_FACTS(), CLEAN, SUBMIT_FACTS(), say({ state: "push-failed", details: "fatal: could not read Username" }, 1)]);
  const code = await previewCode(ctx);
  ctx.clock.t += MIN_CONFIRM_MS;
  const r = await submit(ctx, code);
  assert.equal(r.isError, true);
  assert.match(r.text, /may not be signed in/);
  assert.match(r.text, /Technical details \(for support\): fatal: could not read Username/);
});

test("the preview refuses when the shared version moved, an earlier submission is waiting, or too many went in the last hour", async () => {
  const hourAgo = (mins) => new Date(1_000_000 - mins * 60_000).toISOString();
  const cases = [
    [{ sharedChanged: true }, /Someone else has changed this workflow/],
    [{ submissions: [{ workflow: "workflows/site-health-alert", branch: "n8n-dev/x", at: hourAgo(300), open: true }] }, /already have a change to this workflow waiting/],
    [{ submissions: [1, 2, 3].map((i) => ({ workflow: `workflows/w${i}`, branch: `n8n-dev/w${i}`, at: hourAgo(i * 10), open: false })) }, /already sent 3 changes in the last hour/],
  ];
  for (const [extra, expected] of cases) {
    const ctx = checked([CLEAN, SUBMIT_FACTS(extra)]);
    const r = await preview(ctx);
    assert.match(r.text, expected);
    assert.doesNotMatch(r.text, /is \d{6}/);
  }
  // controls: the same facts without the problem, or with old/closed/other-workflow submissions, are fine
  const fine = [
    {},
    { sharedChanged: false },
    { submissions: [{ workflow: "workflows/site-health-alert", branch: "n8n-dev/x", at: hourAgo(300), open: false }] },
    { submissions: [{ workflow: "workflows/another", branch: "n8n-dev/y", at: hourAgo(300), open: true }] },
    { submissions: [1, 2, 3].map((i) => ({ workflow: `workflows/w${i}`, branch: `n8n-dev/w${i}`, at: hourAgo(61 + i), open: false })) },
    { submissions: [1, 2].map((i) => ({ workflow: `workflows/w${i}`, branch: `n8n-dev/w${i}`, at: hourAgo(i), open: false })) },
  ];
  for (const extra of fine) assert.match((await preview(checked([CLEAN, SUBMIT_FACTS(extra)]))).text, /Everything is in order/, JSON.stringify(extra).slice(0, 60));
});

test("a preview says when it could not refresh from the team's repository", async () => {
  const ctx = checked([CLEAN, SUBMIT_FACTS({ fetched: false })]);
  assert.match((await preview(ctx)).text, /couldn't reach the team's repository/);
  assert.doesNotMatch((await preview(checked([CLEAN, SUBMIT_FACTS({ fetched: true })]))).text, /couldn't reach/);
});

// ---------- an editor left over from earlier: refusing to start, bringing it back, throwing it away ----------
const LEFT = { kind: "editor-stopped", workflow: "workflows/site-health-alert", drift: false, changes: 2, ageMs: 5 * 3600_000, age: "about 5 hours ago", stale: false };

test("ui_start does not open a new editor over one that is still there: it says what is there and offers the choices", async () => {
  for (const [state, session, expected] of [
    ["already-running", { ...LEFT, kind: "editor-running" }, /is still open, with your changes in it/],
    ["already-running", LEFT, /was stopped \(probably by a restart\)/],
    ["pending-edits", { ...LEFT, kind: "saved-edits", changes: 3 }, /3 changes from about 5 hours ago that were saved when the editor closed but never applied/],
  ]) {
    const ctx = build({ answers: [say({ state, message: "x", session }, 1)] });
    const r = await ctx.byName.ui_start.handler({ workflow: "site-health-alert" });
    assert.equal(r.isError, true, state);
    assert.match(r.text, /haven't opened a new editor/);
    assert.match(r.text, expected);
    assert.equal(ctx.state.chamber, null, "nothing is recorded as opened");
  }
});

test("ui_resume brings the earlier editor back with its address and login, and records it as open", async () => {
  const resumed = say({ state: "resumed", address: "http://127.0.0.1:5678", login: { email: "test@test.com", password: "Test1234" }, workflow: "workflows/site-health-alert", session: LEFT });
  const ctx = build({ answers: [resumed] });
  const r = await ctx.byName.ui_resume.handler({});
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls[0].args, ["ui-resume", "--json"]);
  assert.match(r.text, /Your earlier test editor is back, with your changes in it/);
  assert.match(r.text, /http:\/\/127\.0\.0\.1:5678/);
  assert.equal(ctx.state.chamber, "site-health-alert");
  // closing it straight away is refused, the same as for a fresh editor
  ctx.clock.t += 3_000;
  assert.match((await ctx.byName.ui_stop.handler({ theirWords: "I am done" })).text, /only just opened/);
});

test("ui_resume says why it did not bring anything back", async () => {
  for (const [answer, expected] of [
    [say({ state: "nothing-to-resume", session: { kind: "none" } }, 1), /no earlier test editor to bring back/],
    [say({ state: "drifted", session: { ...LEFT, drift: true } }, 1), /workflow has changed since then/],
    [say({ state: "failed", details: "docker: boom" }, 1), /Docker Desktop/],
  ]) {
    const ctx = build({ answers: [answer] });
    const r = await ctx.byName.ui_resume.handler({});
    assert.equal(r.isError, true);
    assert.match(r.text, expected);
    assert.equal(ctx.state.chamber, null);
  }
  assert.equal((await build().byName.ui_resume.handler({ anything: 1 })).isError, true);
  assert.equal((await build({ answers: [{ status: 1, stdout: "junk", out: "junk" }] }).byName.ui_resume.handler({})).isError, true);
});

test("ui_discard needs the person's own words, and then says what was and was not thrown away", async () => {
  for (const args of [{}, { theirWords: "" }, { theirWords: "   " }, { theirWords: "x".repeat(201) }, { theirWords: "yes", extra: 1 }]) {
    const ctx = build({ answers: [say({ state: "discarded", cleaned: true })] });
    assert.equal((await ctx.byName.ui_discard.handler(args)).isError, true, JSON.stringify(args).slice(0, 40));
    assert.equal(ctx.calls.length, 0, "nothing ran");
  }
  const ctx = build({ answers: [say({ state: "discarded", cleaned: true })] });
  ctx.state.chamber = "site-health-alert";
  const r = await ctx.byName.ui_discard.handler({ theirWords: "Yes, throw it away" });
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls[0].args, ["ui-discard", "--json"]);
  assert.match(r.text, /thrown away\. Your workflow and your tests haven't been touched/);
  assert.equal(ctx.state.chamber, null);
  const leftover = await build({ answers: [say({ state: "discarded", cleaned: false }, 1)] }).byName.ui_discard.handler({ theirWords: "yes" });
  assert.match(leftover.text, /may still be left behind/);
  assert.equal(leftover.isError, true);
});

// ---------- tests written from the person's own words ----------
const DRAFT_SPEC = JSON.stringify({
  name: "Down site sends an alert",
  when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "down" }] } },
  then: [{ step: "Send alert", runs: 1 }, { step: "Compose alert", field: "text", contains: "docs is not healthy" }, { endsAt: "Send alert" }],
});
const DRAFT_WORDS = "When a site is down, send an alert that says it is not healthy.";
const DRAFT_TEST = { file: "04-down-site-sends-an-alert.yaml", name: "Down site sends an alert", when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "down" }] } }, then: JSON.parse(DRAFT_SPEC).then, unmocked: ["Send alert"] };
const DRAFT_FACTS = { workflow: "workflows/site-health-alert", tests: [DRAFT_TEST] };
const DRAFT_READY = say({ state: "ready", ...DRAFT_FACTS });
const DRAFT_ADDED = say({ state: "added", ...DRAFT_FACTS });
const draftPreview = (ctx, over = {}) => ctx.byName.draft_test_preview.handler({ workflow: "site-health-alert", spec: DRAFT_SPEC, theirWords: DRAFT_WORDS, ...over });
const draftCode = async (ctx) => (await draftPreview(ctx)).text.match(/is (\d{6})/)[1];
const draftSave = (ctx, code, over = {}) => ctx.byName.draft_test_save.handler({ workflow: "site-health-alert", code, theirWords: "Yes, add it", ...over });
const applyCalls = (ctx) => ctx.calls.filter((c) => c.args[0] === "test-add" && c.args.includes("--apply"));

test("draft_test_preview shows the test in plain when/then sentences, quotes the person's words, and writes nothing", async () => {
  const ctx = build({ answers: [DRAFT_READY] });
  const r = await draftPreview(ctx);
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls[0].args, ["test-add", "workflows/site-health-alert", "--spec", DRAFT_SPEC, "--words", DRAFT_WORDS]);
  assert.match(r.text, /You said: “When a site is down, send an alert that says it is not healthy\.”/);
  assert.match(r.text, /A request comes in with site = “docs”/);
  assert.match(r.text, /“Check site status” answers with status = “down”/);
  assert.match(r.text, /“Send alert” runs once/);
  assert.match(r.text, /The text going into “Compose alert” contains “docs is not healthy”/);
  assert.match(r.text, /The workflow finishes at “Send alert”/);
  assert.match(r.text, /“Send alert”.*no pretend answer/s);
  assert.match(r.text, /will fail until your workflow does this/);
  assert.match(r.text, /Nothing has been added yet/);
  assert.match(r.text, /is 1000\d\d/);
});

test("draft_test_preview says what is wrong in plain words and issues no code, even behind the scenes", async () => {
  const bad = say({ state: "invalid", errors: [{ code: "unknown-step", step: "Sned alert", steps: ["Send alert", "Compose alert"] }, { code: "name-taken", name: "Existing" }] }, 1);
  const ctx = build({ answers: [bad, DRAFT_READY] });
  const r = await draftPreview(ctx);
  assert.match(r.text, /no step called “Sned alert”.*The steps are: “Send alert”, “Compose alert”/);
  assert.match(r.text, /already a test called “Existing”/);
  assert.doesNotMatch(r.text, /is \d{6}/);
  assert.match(r.text, /For you, the assistant.*draft_test_preview again/s);
  assert.match((await draftPreview(ctx)).text, /100000\b/, "the refusal did not create a code");
  const technical = await build({ answers: [say({ state: "invalid", errors: [{ code: "bad-json" }] }, 1)] }).byName.draft_test_preview.handler({ workflow: "site-health-alert", spec: "{", theirWords: DRAFT_WORDS });
  assert.match(technical.text, /adjust how I've described the test/);
});

test("draft_test_preview needs the person's own words and refuses odd arguments before running anything", async () => {
  for (const theirWords of ["", "   ", "x".repeat(501)]) {
    const ctx = build({ answers: [DRAFT_READY] });
    assert.match((await draftPreview(ctx, { theirWords })).text, /your own words/);
    assert.equal(ctx.calls.length, 0);
  }
  const ctx = build();
  for (const args of [{ workflow: "site-health-alert", spec: "{}" }, { workflow: "site-health-alert", spec: 5, theirWords: "x" }, { workflow: "site-health-alert", spec: "{}", theirWords: "x", file: "../x" }]) {
    assert.equal((await ctx.byName.draft_test_preview.handler(args)).isError, true, JSON.stringify(args));
  }
  assert.equal(ctx.calls.length, 0);
});

test("draft_test_save adds exactly the test that was previewed, once the person has had time to read it", async () => {
  const ctx = build({ answers: [DRAFT_READY, DRAFT_ADDED] });
  ctx.state.checks["site-health-alert"] = { passed: true, hash: "old" };
  const code = await draftCode(ctx);
  ctx.clock.t += MIN_CONFIRM_MS;
  const r = await draftSave(ctx, code);
  assert.equal(r.isError, false);
  assert.match(r.text, /Added the test “Down site sends an alert”/);
  assert.match(r.text, /fail until your workflow does this, which is expected/);
  const [apply] = applyCalls(ctx);
  assert.deepEqual(apply.args, ["test-add", "workflows/site-health-alert", "--spec", DRAFT_SPEC, "--words", DRAFT_WORDS, "--apply"]);
  assert.equal(ctx.state.checks["site-health-alert"], undefined, "tests changed, so an earlier check no longer counts");
});

test("draft_test_save cannot be given a different test than the one previewed", async () => {
  const ctx = build({ answers: [DRAFT_READY] });
  const code = await draftCode(ctx);
  ctx.clock.t += MIN_CONFIRM_MS;
  for (const extra of [{ spec: "{}" }, { theirWordsForTest: "other" }, { file: "x.yaml" }]) assert.equal((await draftSave(ctx, code, extra)).isError, true);
  assert.equal(applyCalls(ctx).length, 0);
});

test("draft_test_save is refused, and adds nothing, without time, words, a valid code, or when things changed", async () => {
  const quick = build({ answers: [DRAFT_READY] });
  const code = await draftCode(quick);
  quick.clock.t += MIN_CONFIRM_MS - 1;
  assert.match((await draftSave(quick, code)).text, /go-ahead first/);
  quick.clock.t += 1;
  for (const theirWords of ["", "   ", "x".repeat(201)]) assert.match((await draftSave(quick, code, { theirWords })).text, /need to hear from you/);
  assert.equal((await draftSave(quick, "000000")).isError, true, "a code that was never issued");
  assert.equal((await draftSave(quick, code, { workflow: "store-pickup-reminder" })).isError, true, "a code for another workflow");
  assert.equal(applyCalls(quick).length, 0);

  const moved = build({ answers: [DRAFT_READY] });
  const code2 = await draftCode(moved);
  moved.clock.t += MIN_CONFIRM_MS;
  moved.fsx.files["workflows/site-health-alert/workflow.json"] = '{"v":"edited after the preview"}';
  assert.equal((await draftSave(moved, code2)).isError, true, "the workflow changed after the preview");
  assert.equal(applyCalls(moved).length, 0);
});

test("a code works once, and a newer preview replaces an older one", async () => {
  const ctx = build({ answers: [DRAFT_READY, DRAFT_ADDED, DRAFT_READY, DRAFT_READY] });
  const first = await draftCode(ctx);
  ctx.clock.t += MIN_CONFIRM_MS;
  assert.equal((await draftSave(ctx, first)).isError, false);
  assert.equal((await draftSave(ctx, first)).isError, true, "replayed");
  const older = await draftCode(ctx);
  const otherSpec = JSON.stringify({ ...JSON.parse(DRAFT_SPEC), name: "A different test" });         // a different test, so a different code
  const newer = (await draftPreview(ctx, { spec: otherSpec })).text.match(/is (\d{6})/)[1];
  assert.notEqual(older, newer);
  ctx.clock.t += MIN_CONFIRM_MS;
  assert.equal((await draftSave(ctx, older)).isError, true, "the older preview no longer counts once a newer one was shown");
  assert.equal(applyCalls(ctx).length, 1, "only the first save ran");
});

test("draft_test_save reports a test that no longer fits as a plain refusal", async () => {
  const taken = say({ state: "invalid", errors: [{ code: "name-taken", name: "Down site sends an alert" }] }, 1);
  const ctx = build({ answers: [DRAFT_READY, taken] });
  const code = await draftCode(ctx);
  ctx.clock.t += MIN_CONFIRM_MS;
  assert.match((await draftSave(ctx, code)).text, /already a test called “Down site sends an alert”/);
});

test("draft_test_remove needs the person's words, takes back only what was added, and says why when it cannot", async () => {
  for (const args of [{ workflow: "site-health-alert", file: "04-x.yaml" }, { workflow: "site-health-alert", file: "04-x.yaml", theirWords: "  " }]) {
    const ctx = build({ answers: [say({ state: "removed", file: "04-x.yaml" })] });
    assert.equal((await ctx.byName.draft_test_remove.handler(args)).isError, true);
    assert.equal(ctx.calls.length, 0);
  }
  for (const [state, expected, isError] of [
    ["removed", /Removed the test “Down site sends an alert”/, false], ["already-gone", /already gone/, false],
    ["not-drafted", /only take back tests that I added/, true], ["changed-since", /edited that test since I wrote it/, true], ["bad-file", /doesn't look like the name of a test/, true],
  ]) {
    const ctx = build({ answers: [say({ state, file: "04-x.yaml", name: "Down site sends an alert" }, state === "removed" ? 0 : 1)] });
    const r = await ctx.byName.draft_test_remove.handler({ workflow: "site-health-alert", file: "04-x.yaml", theirWords: "Yes, take it back" });
    assert.match(r.text, expected, state);
    assert.equal(r.isError, isError, state);
    assert.deepEqual(ctx.calls[0].args, ["test-remove", "workflows/site-health-alert", "--file", "04-x.yaml"]);
  }
});

test("the three draft tools refuse bad workflow names without running anything", async () => {
  const ctx = build();
  for (const workflow of BAD_NAMES) {
    assert.equal((await ctx.byName.draft_test_preview.handler({ workflow, spec: DRAFT_SPEC, theirWords: DRAFT_WORDS })).isError, true, workflow);
    assert.equal((await ctx.byName.draft_test_save.handler({ workflow, code: "123456", theirWords: "yes" })).isError, true, workflow);
    assert.equal((await ctx.byName.draft_test_remove.handler({ workflow, file: "01-x.yaml", theirWords: "yes" })).isError, true, workflow);
  }
  assert.equal(ctx.calls.length, 0);
});

// ---------- the drafting flow when the person is slow, or asks for several tests ----------
const MIN = 60_000;
const TEST_B = { file: "05-site-just-under-the-line-sends-nothing.yaml", name: "Site just under the line sends nothing", when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "up" }] } }, then: [{ step: "Send alert", doesNotRun: true }], unmocked: [] };
const MANY_READY = say({ state: "ready", workflow: "workflows/site-health-alert", tests: [DRAFT_TEST, TEST_B] });
const MANY_ADDED = say({ state: "added", workflow: "workflows/site-health-alert", tests: [DRAFT_TEST, TEST_B] });
const MANY_SPEC = JSON.stringify([JSON.parse(DRAFT_SPEC), { name: TEST_B.name, when: TEST_B.when, then: TEST_B.then }]);

test("a reply that takes a person 14 or 22 minutes (as in the first real session) still works", async () => {
  for (const minutes of [14, 22, 90]) {
    const ctx = build({ answers: [DRAFT_READY, DRAFT_ADDED] });
    const code = await draftCode(ctx);
    ctx.clock.t += minutes * MIN;
    const r = await draftSave(ctx, code);
    assert.equal(r.isError, false, `${minutes} minutes: ${r.text.slice(0, 80)}`);
    assert.match(r.text, /Added the test/);
  }
});

test("control: a preview left for three hours is out of date, and the assistant is told to show it again and wait", async () => {
  const ctx = build({ answers: [DRAFT_READY, DRAFT_ADDED] });
  const code = await draftCode(ctx);
  ctx.clock.t += 3 * 60 * MIN;
  const r = await draftSave(ctx, code);
  assert.equal(r.isError, true);
  assert.match(r.text, /That preview of the test is out of date, so I need to show it to you again/);
  assert.match(r.text, /For you, the assistant.*expired.*draft_test_preview again.*STOP.*Never preview and save in the same step/s);
  assert.equal(applyCalls(ctx).length, 0);
});

test("a request with several tests is previewed together, confirmed with one yes, and added together", async () => {
  const ctx = build({ answers: [MANY_READY, MANY_ADDED] });
  const r = await draftPreview(ctx, { spec: MANY_SPEC });
  assert.match(r.text, /Here are the 2 tests I would add/);
  assert.match(r.text, /Test 1: “Down site sends an alert”/);
  assert.match(r.text, /Test 2: “Site just under the line sends nothing”/);
  assert.match(r.text, /“Send alert” does not run/);
  assert.match(r.text, /I'll add them all/);
  assert.equal(r.text.match(/is (\d{6})/g).length, 1, "one code for the whole set");
  const code = r.text.match(/is (\d{6})/)[1];
  ctx.clock.t += MIN_CONFIRM_MS;
  const saved = await draftSave(ctx, code);
  assert.match(saved.text, /Added 2 tests:/);
  assert.match(saved.text, /“Down site sends an alert”/);
  assert.match(saved.text, /“Site just under the line sends nothing”/);
  assert.match(saved.text, /For you, the assistant.*05-site-just-under-the-line-sends-nothing\.yaml/s);
  assert.deepEqual(applyCalls(ctx)[0].args.slice(3, 4), [MANY_SPEC], "the whole set, exactly as previewed");
});

test("when one test in a set is wrong the reply says which, and nothing gets a code", async () => {
  const bad = say({ state: "invalid", count: 2, errors: [{ code: "unknown-step", step: "Sned alert", steps: ["Send alert"], index: 1, testName: "Second one" }] }, 1);
  const ctx = build({ answers: [bad, MANY_READY] });
  const r = await draftPreview(ctx, { spec: MANY_SPEC });
  assert.match(r.text, /can't add those tests yet/);
  assert.match(r.text, /Test 2 \(“Second one”\): There is no step called “Sned alert”/);
  assert.doesNotMatch(r.text, /is \d{6}/);
  assert.match((await draftPreview(ctx, { spec: MANY_SPEC })).text, /100000\b/, "no code was created behind the scenes");
});

test("every two-step flow tells the assistant, in the same way, what to do with an old or replaced code", async () => {
  const stale = (ctx) => ctx;
  const cases = [
    [() => build({ files: withSession(), answers: [PREVIEW_WITH_CHANGES] }), (ctx, code) => ctx.byName.pull_apply.handler({ workflow: "site-health-alert", code }), async (ctx) => (await ctx.byName.pull_preview.handler({ workflow: "site-health-alert" })).text.match(/code (\d{6})/)[1], "pull_preview", /preview of the changes/],
    [() => build({ files: withApply(), answers: [FIX_READY] }), (ctx, code) => ctx.byName.update_tests.handler({ workflow: "site-health-alert", code }), explainThenCode, "explain_test_failures", /preview of the test updates/],
    [() => build({ answers: [DRAFT_READY] }), (ctx, code) => draftSave(ctx, code), draftCode, "draft_test_preview", /preview of the test/],
  ];
  for (const [make, act, getCode, previewTool, wording] of cases) {
    const ctx = make();
    const code = await getCode(ctx);
    ctx.clock.t += 3 * 60 * MIN;
    const r = await act(ctx, code);
    assert.equal(r.isError, true);
    assert.match(r.text, wording);
    assert.match(r.text, new RegExp(`${previewTool} again`));
    assert.match(r.text, /Never preview and save in the same step/);
  }
  void stale;
});

test("pull_preview says plainly when the edits were already applied", async () => {
  const ctx = build({ files: withSession(), answers: [say({ state: "already-applied", workflow: "workflows/site-health-alert" })] });
  const r = await ctx.byName.pull_preview.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, false);
  assert.match(r.text, /already applied to your workflow, so there is nothing waiting/);
  assert.doesNotMatch(r.text, /code \d{6}/);
});

test("an old preview of a change to send for review is explained the same way, and nothing is sent", async () => {
  const ctx = sendContext();
  const code = await previewCode(ctx);
  ctx.clock.t += 3 * 60 * MIN;
  const r = await submit(ctx, code);
  assert.equal(r.isError, true);
  assert.match(r.text, /That preview of the sending is out of date/);
  assert.match(r.text, /submit_preview again.*Never preview and save in the same step/s);
  assert.equal(sendCalls(ctx).length, 0, "nothing was sent");
});

// ---------- describe_workflow ----------
const DESCRIBED = say({
  state: "described", workflow: "workflows/site-health-alert", name: "Site health alert",
  steps: [{ name: "Health check request", kind: "start" }, { name: "Check site status", kind: "outside" }, { name: "Compose alert", kind: "plain" }, { name: "Send alert", kind: "outside" }],
  data: { start: { site: "docs" }, services: { "Check site status": { status: "down", latency_ms: 1200 }, "Send alert": { ok: true } } },
  tests: [{ file: "01.yaml", name: "Down site sends an alert", when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "down", latency_ms: 1200 }] } }, then: [{ step: "Send alert", runs: 1 }] }],
  moreTests: 0, unreadable: [],
});

test("describe_workflow tells the person what the workflow does and gives the assistant the exact names and data", async () => {
  const ctx = build({ answers: [DESCRIBED] });
  const r = await ctx.byName.describe_workflow.handler({ workflow: "site-health-alert" });
  assert.equal(r.isError, false);
  assert.deepEqual(ctx.calls[0].args, ["describe", "workflows/site-health-alert"]);
  assert.match(r.text, /“Site health alert” works like this, step by step:/);
  assert.match(r.text, /1\. “Health check request” \(where it starts\)/);
  assert.match(r.text, /2\. “Check site status” \(talks to an outside service\)/);
  assert.match(r.text, /3\. “Compose alert”\n/);
  assert.match(r.text, /It has 1 test:\n• “Down site sends an alert”/);
  const person = r.text.split("For you, the assistant")[0];
  assert.doesNotMatch(person, /latency_ms|1200|\{/, "no field names or data shown to the person");
  assert.match(r.text, /For you, the assistant.*use EXACTLY these step names and field names.*never invent a field name/s);
  assert.match(r.text, /Check site status \[outside\]/);
  assert.match(r.text, /"Check site status":\{"status":"down","latency_ms":1200\}/);
  assert.match(r.text, /Data the starting event carries.*"site":"docs"/s);
});

test("describe_workflow is read-only, refuses bad names and odd arguments before running anything, and handles odd answers", async () => {
  const ctx = build({ answers: [DESCRIBED] });
  assert.equal(ctx.byName.describe_workflow.annotations.readOnlyHint, true);
  for (const workflow of BAD_NAMES) assert.equal((await ctx.byName.describe_workflow.handler({ workflow })).isError, true, workflow);
  assert.equal((await ctx.byName.describe_workflow.handler({ workflow: "site-health-alert", extra: 1 })).isError, true);
  assert.equal(ctx.calls.length, 0);
  assert.equal((await build({ answers: [{ status: 1, stdout: "junk", out: "junk" }] }).byName.describe_workflow.handler({ workflow: "site-health-alert" })).isError, true);
  assert.equal((await build({ answers: [say({ state: "nope" }, 1)] }).byName.describe_workflow.handler({ workflow: "site-health-alert" })).isError, true);
});

test("the assistant is steered to describe_workflow before writing a test", async () => {
  const { byName } = build();
  assert.match(byName.draft_test_preview.description, /First call describe_workflow and copy the step names and field names/);
  assert.match(byName.describe_workflow.description, /BEFORE writing a test with draft_test_preview/);
  assert.match(byName.describe_workflow.description, /never invent a field name/);
});
