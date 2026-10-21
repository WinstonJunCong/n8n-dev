// Tests for mcp/replies.mjs: what the person reads. No Docker, no processes.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  JARGON, describeChanges, describeNotApplied, plainAssertion,
  replyForCheck, replyForStart, replyForStop, replyForStopRefused, replyForUndo, describeUndone, replyForTestFix, replyForTestUpdate, replyForSubmitPreview, replyForSubmitRefused, replyForSend, replyForSession, replyForStartRefused, replyForResume, replyForDiscard, describeOffer, describeWhenThen, replyForDraftPreview, replyForDraftRefused, replyForDraftSaved, replyForDraftRemoved, replyForStaleCode, replyForPreview, replyForApply, replyForStatus,
} from "./replies.mjs";

// The part of a reply meant for the person: without the line for the assistant and the support details.
const forPerson = (text) => text.split("For you, the assistant")[0].split("Technical details (for support)")[0];
// "Docker Desktop" is a program the person has to open, so its name is allowed; nothing else technical is.
// A review link is an address, not wording: it is allowed to contain words like "pull".
const lintable = (text) => forPerson(text).replace(/Docker Desktop/g, "").replace(/https?:\/\/\S+/g, "");

const CHANGES = [{ kind: "changed", node: "Compose alert", details: [{ label: "text", from: "ALERT: down", to: "TEST: down" }] }];
const FACTS = { workflow: "workflows/site-health-alert", changes: CHANGES, notApplied: [], notes: [], missing: [], conflicts: [], changedMeanwhile: false };

// ---------- what changed ----------
test("a changed value is shown as the exact old and new text", () => {
  assert.deepEqual(describeChanges(CHANGES), ["In “Compose alert”, the text changed from “ALERT: down” to “TEST: down”"]);
});

test("every kind of change has its own plain sentence", () => {
  const lines = describeChanges([
    { kind: "changed", node: "A", details: [] },
    { kind: "renamed", node: "B", to: "C" },
    { kind: "added", node: "D", outside: true, trigger: true },
    { kind: "removed", node: "E" },
    { kind: "connected", from: "F", to: "G" },
    { kind: "disconnected", from: "H", to: "I" },
  ]);
  assert.equal(lines.length, 8);
  assert.match(lines[0], /“A” was changed/);
  assert.match(lines[1], /renamed to “C”/);
  assert.match(lines[2], /new step was added: “D”/);
  assert.match(lines[3], /pretend answer/);
  assert.match(lines[4], /second starting point/);
  assert.match(lines[5], /“E” was removed/);
  assert.match(lines[6], /“F” is now connected to “G”/);
  assert.match(lines[7], /no longer connected/);
});

test("left-out changes are explained, and an unknown reason still gets a sentence", () => {
  const lines = describeNotApplied([{ node: "Send alert", reason: "simulated-edited" }, { node: "X", reason: "credentials" }, { node: "Y", reason: "something-new" }]);
  assert.match(lines[0], /stand-in/);
  assert.match(lines[1], /logins never come from the test editor/);
  assert.match(lines[2], /“Y” was left out/);
});

// ---------- the safe test editor ----------
test("starting gives the address and sign-in in plain words and a hint for the assistant", () => {
  const r = replyForStart({ state: "started", address: "http://127.0.0.1:5678", login: { email: "a@b.c", password: "pw1" } });
  assert.equal(r.isError, false);
  assert.match(r.text, /http:\/\/127\.0\.0\.1:5678/);
  assert.match(r.text, /a@b\.c/);
  assert.match(r.text, /For you, the assistant.*ui_stop/s);
});

test("every way starting can fail has a plain explanation and is an error", () => {
  for (const state of ["already-running", "docker-missing", "no-tests", "bad-port", "build-failed", "failed", "something-else"]) {
    const r = replyForStart({ state, details: "docker: not found" });
    assert.equal(r.isError, true, state);
    assert.ok(forPerson(r.text).length > 20, state);
  }
  assert.match(replyForStart({ state: "docker-missing" }).text, /Docker Desktop/);
  assert.match(replyForStart({ state: "already-running" }).text, /ui_stop/);
});

test("stopping says what the person changed and offers to apply it, without a command", () => {
  const r = replyForStop({ state: "saved", cleaned: true, summary: FACTS });
  assert.equal(r.isError, false);
  assert.match(r.text, /changed from “ALERT: down” to “TEST: down”/);
  assert.match(r.text, /Want me to apply these/);
});

test("stopping with no changes says so, and does not offer to apply", () => {
  const r = replyForStop({ state: "saved", cleaned: true, summary: { ...FACTS, changes: [] } });
  assert.match(r.text, /didn't change anything/);
  assert.doesNotMatch(r.text, /Want me to apply/);
});

test("stopping says plainly when the editor may not have closed, and when nothing was open", () => {
  assert.equal(replyForStop({ state: "saved", cleaned: false, summary: FACTS }).isError, true);
  assert.match(replyForStop({ state: "nothing-running", cleaned: true }).text, /nothing to save/);
  assert.match(replyForStop({ state: "no-session" }).text, /no test editor session/i);
});

test("starting ends by asking the person to say when they are done, and tells the assistant to wait", () => {
  const r = replyForStart({ state: "started", address: "http://127.0.0.1:5678", login: { email: "a@b.c", password: "p" } });
  assert.match(forPerson(r.text), /tell me “I'm done”/);
  assert.match(forPerson(r.text), /won't close it until you say so/);
  assert.match(r.text, /For you, the assistant.*STOP.*Do not call any other tool.*theirWords/s);
});

test("a refused stop explains itself to the person and tells the assistant to wait", () => {
  for (const why of ["too-soon", "no-words"]) {
    const r = replyForStopRefused(why);
    assert.equal(r.isError, true);
    assert.match(forPerson(r.text), /tell me you've finished|Tell me when you're done/);
    assert.match(r.text, /For you, the assistant/);
  }
});

// ---------- applying ----------
test("a preview shows the changes, says nothing has happened yet, and passes the code only to the assistant", () => {
  const r = replyForPreview({ state: "ready", ...FACTS }, "123456");
  assert.equal(r.isError, false);
  assert.match(r.text, /Nothing has been changed yet/);
  assert.doesNotMatch(forPerson(r.text), /123456/);
  assert.match(r.text, /For you, the assistant.*123456/s);
});

test("a preview mentions what was left out and what was not saved", () => {
  const r = replyForPreview({ state: "ready", ...FACTS, notApplied: [{ node: "Send alert", reason: "simulated-edited" }], missing: ["down alert"] }, "1");
  assert.match(r.text, /stand-in/);
  assert.match(r.text, /“down alert”/);
});

test("each way a preview can be blocked says why, in plain words", () => {
  const conflict = replyForPreview({ state: "blocked", reason: "conflict", ...FACTS }, undefined);
  assert.match(conflict.text, /two of your test copies/);
  const meanwhile = replyForPreview({ state: "blocked", reason: "changed-meanwhile", ...FACTS }, undefined);
  assert.match(meanwhile.text, /changed somewhere else/);
  const scan = replyForPreview({ state: "blocked", reason: "scan", findings: [{ node: "Send alert", rule: "secret" }, { node: "Other", rule: "new-rule" }], ...FACTS }, undefined);
  assert.match(scan.text, /“Send alert” has a key or password typed straight into a step/);
  assert.match(scan.text, /“Other” has something that should not be typed into a step/);
  for (const r of [conflict, meanwhile, scan]) assert.equal(r.isError, true);
});

test("nothing to apply, no saved changes, and the wrong workflow are each explained", () => {
  assert.match(replyForPreview({ state: "nothing", ...FACTS, changes: [] }).text, /nothing to apply/);
  assert.match(replyForPreview({ state: "no-session" }).text, /don't have any saved changes/);
  assert.match(replyForPreview({ state: "wrong-workflow", expected: "a", given: "b" }).text, /“a”, not “b”/);
});

test("a successful apply names the workflow and the changes, and tells the assistant to check again", () => {
  const r = replyForApply({ state: "applied", ...FACTS });
  assert.match(r.text, /Done\. Your change is now in the workflow “site-health-alert”/);
  assert.match(r.text, /changed from “ALERT: down”/);
  assert.match(r.text, /For you, the assistant.*check_workflow/s);
});

test("a failed write is an error, and any other state is explained like a preview", () => {
  assert.equal(replyForApply({ state: "write-failed", ...FACTS }).isError, true);
  assert.match(replyForApply({ state: "blocked", reason: "conflict", ...FACTS }).text, /two of your test copies/);
});

// ---------- checks and status ----------
const PASSING = { allPass: true, scan: [], structure: [], tests: [{ name: "down alert", pass: true, checks: [] }, { name: "up", pass: true, checks: [] }] };

test("a passing check lists the tests in plain words", () => {
  const r = replyForCheck("site-health-alert", PASSING);
  assert.equal(r.isError, false);
  assert.match(r.text, /passed every check/);
  assert.match(r.text, /2 of 2 tests passed/);
  assert.match(r.text, /down alert/);
});

test("a failing check says what failed in plain words", () => {
  const r = replyForCheck("w", {
    allPass: false,
    scan: [{ node: "Send alert", rule: "host" }],
    structure: [{ node: "-", message: "Expected exactly 1 trigger, found 2" }],
    tests: [
      { name: "down alert", pass: false, checks: [{ pass: true, assertion: 'node "A" called 1 time' }, { pass: false, assertion: 'node "Send alert" called 1 time', detail: "called 0 time(s)" }] },
      { name: "broken", pass: false, error: "Unmocked outside step was reached", checks: [] },
      { name: "fine", pass: true, checks: [] },
    ],
  });
  assert.match(r.text, /isn't ready yet/);
  assert.match(r.text, /1 of 3 tests passed/);
  assert.match(r.text, /“Send alert” has a web address typed straight into a step/);
  assert.match(r.text, /isn't built correctly: Expected exactly 1 trigger/);
  assert.match(r.text, /The test “down alert” failed: “Send alert” should have run 1 time but ran 0 time/);
  assert.match(r.text, /The test “broken” couldn't run/);
  assert.match(r.text, /Technical details \(for support\): Unmocked/);
});

test("assertions are put in plain words, and unknown ones are passed through", () => {
  assert.equal(plainAssertion({ assertion: 'node "X" not called', detail: "it was called" }), "“X” should not have run, but it did");
  assert.equal(plainAssertion({ assertion: 'workflow ends at "Y"', detail: "never reached" }), "the workflow should have finished at “Y”");
  assert.match(plainAssertion({ assertion: 'node "X" output.text contains hello', detail: 'output.text = "bye"' }), /“X” should contain text hello \(it had: "bye"\)/);
  assert.equal(plainAssertion({ assertion: "something odd" }), "something odd");
});

test("a check that gave no report is an error that points at Docker Desktop", () => {
  const r = replyForCheck("w", null, "boom");
  assert.equal(r.isError, true);
  assert.match(r.text, /Docker Desktop/);
});

test("status is answered in plain words for all three outcomes", () => {
  assert.match(replyForStatus(0).text, /No test editor is open/);
  assert.match(replyForStatus(1).text, /still open/);
  const unknown = replyForStatus(2, "UNKNOWN");
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Docker Desktop/);
});

// ---------- the person never reads technical words ----------
const everyReply = () => {
  const out = [];
  const scanFinding = [{ node: "Send alert", rule: "secret" }, { node: "N", rule: "airtable-id" }, { node: "N", rule: "chat-id" }, { node: "N", rule: "host" }, { node: "N", rule: "live-n8n" }, { node: "N", rule: "custom" }];
  const rich = { ...FACTS,
    changes: [...CHANGES, { kind: "renamed", node: "A", to: "B" }, { kind: "added", node: "C", outside: true, trigger: true }, { kind: "removed", node: "D" }, { kind: "connected", from: "E", to: "F" }, { kind: "disconnected", from: "G", to: "H" }],
    notApplied: [{ node: "S", reason: "simulated-edited" }, { node: "S", reason: "simulated-removed" }, { node: "S", reason: "credentials" }],
    missing: ["t"], conflicts: [{}], changedMeanwhile: true };
  for (const state of ["already-running", "docker-missing", "no-tests", "bad-port", "build-failed", "failed", "x"]) out.push(replyForStart({ state, details: "docker: command not found" }));
  out.push(replyForStart({ state: "started", address: "http://127.0.0.1:5678", login: { email: "a@b.c", password: "p" } }));
  out.push(replyForStopRefused("too-soon"), replyForStopRefused("no-words"));
  const facts = { workflowChanged: true, newWorkflow: false, workflowChanges: rich.changes, tests: [{ status: "A", name: "N" }, { status: "D", name: "O" }, { status: "M", name: null }] };
  out.push(replyForSubmitPreview({ state: "ready", testsChanged: true, testsRemoved: true, noTestReason: "a typo" }, facts, "1"), replyForSubmitPreview({ state: "ready", testsChanged: false, testsRemoved: false, noTestReason: "a typo" }, { ...facts, tests: [] }, "1"));
  for (const code of ["editor-open", "editor-unknown", "no-check", "check-stale", "check-failed", "no-change", "other-files", "workflow-without-test", "reason-too-long", "no-git", "no-repo", "no-base", "no-facts", "shared-changed", "open-submission", "rate-limit", "other"]) out.push(replyForSubmitPreview({ state: "blocked", reasons: [{ code, count: 1, max: 3 }] }, facts));
  out.push(replyForSubmitPreview({ state: "ready", testsChanged: true, testsRemoved: false, noTestReason: null }, { ...facts, fetched: false }, "1"), replyForSubmitRefused("too-soon"), replyForSubmitRefused("no-words"));
  const left = { kind: "editor-stopped", workflow: "flows/demo", drift: false, changes: 2, ageMs: 5 * 3600_000, age: "about 5 hours ago", stale: false };
  for (const s of [left, { ...left, kind: "editor-running" }, { ...left, kind: "editor-orphan" }, { ...left, kind: "saved-edits" }, { ...left, stale: true, age: "5 days ago" }, { ...left, drift: true }, { ...left, kind: "saved-edits", drift: true }, { ...left, age: null }, { kind: "none" }, { kind: "unknown" }]) {
    out.push(replyForSession(s));
    const refused = replyForStartRefused({ state: "already-running", session: s });
    if (refused) out.push(refused);
  }
  for (const j of [{ state: "resumed", address: "http://127.0.0.1:5678", login: { email: "a@b.c", password: "p" } }, { state: "drifted", session: left }, { state: "nothing-to-resume" }, { state: "failed", details: "docker: boom" }]) out.push(replyForResume(j));
  for (const j of [{ state: "discarded", cleaned: true }, { state: "discarded", cleaned: false }, { state: "no-words" }, { state: "failed" }]) out.push(replyForDiscard(j));
  const draftTest = { name: "Down site", when: { trigger: { site: "docs", n: 2 }, services: { "Check status": [{ status: "down" }] } }, then: [{ step: "Send alert", runs: 1 }, { step: "Ignore", doesNotRun: true }, { step: "Compose", field: "text", contains: "y" }, { endsAt: "Send alert" }], unmocked: ["Send alert"] };
  const draft = { state: "ready", tests: [draftTest] };
  out.push(replyForDraftPreview({ state: "ready", tests: [draftTest, { ...draftTest, name: "Second" }] }, "1", "two tests please"), replyForDraftPreview({ state: "invalid", count: 2, errors: [{ code: "unknown-step", step: "Y", steps: ["A"], index: 1, testName: "Second" }] }));
  out.push(replyForDraftPreview(draft, "1", "When a site is down, alert."), replyForDraftPreview({ ...draft, tests: [{ ...draftTest, unmocked: [] }] }, "1", "w"), replyForDraftPreview({ state: "nope" }));
  for (const code of ["bad-name", "name-taken", "unknown-step", "not-outside", "empty-then", "too-many-checks", "duplicate-check", "step-name-unsupported", "too-many-tests", "no-words", "bad-json"]) out.push(replyForDraftPreview({ state: "invalid", errors: [{ code, name: "X", step: "Y", steps: ["A"], outside: ["A"], max: 3 }] }));
  out.push(replyForStaleCode("changes", "pull_preview", "That code has expired."), replyForStaleCode("test", "draft_test_preview"), replyForStaleCode("sending", "submit_preview", "x"), replyForPreview({ state: "already-applied" }));
  out.push(replyForDraftSaved({ state: "added", tests: [{ name: "A", file: "02-a.yaml" }, { name: "B", file: "03-b.yaml" }] }));
  for (const code of ["too-many-in-preview"]) out.push(replyForDraftPreview({ state: "invalid", count: 2, errors: [{ code, max: 6, index: 0, testName: "T" }] }));
  out.push(replyForDraftRefused("too-soon"), replyForDraftRefused("no-words"), replyForDraftSaved({ state: "added", tests: [{ name: "Down site", file: "04-x.yaml" }] }), replyForDraftSaved({ state: "failed" }));
  for (const state of ["removed", "already-gone", "not-drafted", "changed-since", "bad-file", "other"]) out.push(replyForDraftRemoved({ state, file: "04-x.yaml", name: "Down site" }));
  out.push(replyForSend({ state: "sent" }, "https://github.com/acme/flows/pull/new/n8n-dev/demo-20261018-0705"), replyForSend({ state: "sent" }, null));
  for (const state of ["nothing", "push-failed", "no-identity", "no-remote", "no-git", "no-repo", "no-base", "failed", "bad-branch"]) out.push(replyForSend({ state, details: "fatal: could not read Username" }, null));
  for (const state of ["ready", "nothing", "unexplained", "no-change", "wrong-workflow", "failed", "other"]) out.push(replyForTestFix({ state, updates: [{ test: "Down", from: "a", to: "b" }], unexplained: [{ test: "Other", reason: "unrelated", assertion: 'node "N" called 1 time', detail: "called 0 time(s)" }, { test: "B", reason: "error" }], expected: "a", given: "b" }, "1"));
  for (const state of ["applied", "write-failed", "ready"]) out.push(replyForTestUpdate({ state, updates: [{ test: "Down", from: "a", to: "b" }], unexplained: [] }));
  for (const state of ["restored", "no-words", "nothing-to-undo", "already-undone", "changed-since", "missing", "write-failed", "other"]) out.push(replyForUndo({ state, changes: rich.changes }));
  for (const j of [{ state: "saved", cleaned: true, summary: rich }, { state: "saved", cleaned: false, summary: FACTS }, { state: "nothing-running" }, { state: "no-session" }]) out.push(replyForStop(j));
  for (const reason of ["conflict", "changed-meanwhile", "scan", "other"]) { out.push(replyForPreview({ state: "blocked", reason, findings: scanFinding, ...rich }, undefined)); out.push(replyForApply({ state: "blocked", reason, ...rich })); }
  out.push(replyForPreview({ state: "ready", ...rich }, "123456"), replyForPreview({ state: "nothing", ...rich, changes: [] }), replyForPreview({ state: "no-session" }), replyForPreview({ state: "wrong-workflow", expected: "a", given: "b" }));
  out.push(replyForApply({ state: "applied", ...rich }), replyForApply({ state: "write-failed", ...rich }));
  out.push(replyForCheck("w", PASSING), replyForCheck("w", null, "x"));
  out.push(replyForCheck("w", { allPass: false, scan: scanFinding, structure: [{ message: "bad" }], tests: [{ name: "t", pass: false, error: "mock missing", checks: [] }, { name: "u", pass: false, checks: [{ pass: false, assertion: 'node "N" called 2 times', detail: "called 0 time(s)" }] }] }));
  for (const code of [0, 1, 2]) out.push(replyForStatus(code, "UNKNOWN: docker"));
  return out;
};

test("the part of any reply meant for the person has no technical words", () => {
  const replies = everyReply();
  assert.ok(replies.length > 30);
  for (const r of replies) {
    for (const re of JARGON) assert.doesNotMatch(lintable(r.text), re, `${re} found in: ${forPerson(r.text)}`);
  }
});

test("no reply asks the person to run a command, open a terminal or edit a file", () => {
  for (const r of everyReply()) {
    assert.doesNotMatch(forPerson(r.text), /\b(run|type|enter|paste)\b[^.\n]*\b(command|terminal|script)\b/i, forPerson(r.text));
    assert.doesNotMatch(forPerson(r.text), /\bedit\b[^.\n]*\bfile\b/i, forPerson(r.text));
  }
});

// Control: the lint must be able to see a violation, or the two tests above could pass for the wrong reason.
test("control: the jargon check catches each kind of technical wording", () => {
  const bad = [
    "Run node harness/n8n-dev.mjs pull now", "Edit workflow.json by hand", "The chamber is open", "This is a dry run", "Run docker ps",
    "It uses --apply", "A mock was used", "The node failed", "Open a terminal", "See .n8n-dev/ui-export", "the readiness scan passed",
  ];
  for (const text of bad) assert.ok(JARGON.some((re) => re.test(lintable(text))), `not caught: ${text}`);
  assert.ok(!JARGON.some((re) => re.test(lintable("Open Docker Desktop and try again"))), "Docker Desktop must be allowed");
});

test("control: the assistant-only part is the only place tool names appear", () => {
  const r = replyForPreview({ state: "ready", ...FACTS }, "123456");
  assert.match(r.text, /pull_apply/);
  assert.doesNotMatch(forPerson(r.text), /pull_apply|check_workflow|ui_stop/);
});

// ---------- undo ----------
test("undo says what was taken back, in plain words, for every kind of change", () => {
  const lines = describeUndone([
    ...CHANGES, { kind: "changed", node: "A", details: [] }, { kind: "renamed", node: "B", to: "C" }, { kind: "added", node: "D" },
    { kind: "removed", node: "E" }, { kind: "connected", from: "F", to: "G" }, { kind: "disconnected", from: "H", to: "I" },
  ]);
  assert.equal(lines[0], "In “Compose alert”, the text is back to “ALERT: down” (it had been changed to “TEST: down”)");
  assert.match(lines[2], /“C” is called “B” again/);
  assert.match(lines[3], /“D” was taken out again/);
  assert.match(lines[4], /“E” was put back/);
  assert.match(lines[5], /“F” is no longer connected to “G”/);
  assert.match(lines[6], /“H” is connected to “I” again/);
});

test("each undo outcome has a plain reply, and only real failures are errors", () => {
  assert.match(replyForUndo({ state: "restored", changes: CHANGES }).text, /Done\. Your workflow is back/);
  assert.match(replyForUndo({ state: "changed-since" }).text, /changed again since/);
  assert.match(replyForUndo({ state: "no-words" }).text, /Say the word/);
  for (const state of ["already-undone", "nothing-to-undo"]) assert.equal(replyForUndo({ state }).isError, false, state);
  for (const state of ["changed-since", "missing", "write-failed", "no-words", "other"]) assert.equal(replyForUndo({ state }).isError, true, state);
});

// ---------- tests broken by a change ----------
const UPD = { test: "Down", from: "ALERT: x", to: "OLALA: x" };
const OTHER = [{ test: "Other", reason: "unrelated", assertion: 'node "N" called 1 time', detail: "called 0 time(s)" }, { test: "Broken", reason: "error" }, { test: "T", reason: "mismatch" }];

test("a test preview shows what the tests expect now and later, asks about intent, and hides the code from the person", () => {
  const r = replyForTestFix({ state: "ready", updates: [UPD], unexplained: OTHER }, "654321");
  assert.match(r.text, /currently expects “ALERT: x”\. It would expect “OLALA: x” instead/);
  assert.match(forPerson(r.text), /Did you mean to change that on purpose/);
  assert.match(forPerson(r.text), /someone who knows the tests/);
  assert.doesNotMatch(forPerson(r.text), /654321|update_tests/);
  assert.match(r.text, /For you, the assistant.*update_tests.*654321/s);
});

test("each way a test explanation can end has a plain reply", () => {
  assert.match(replyForTestFix({ state: "nothing" }).text, /None of the tests need changing/);
  assert.match(replyForTestFix({ state: "unexplained", unexplained: OTHER }).text, /not in a way I can safely fix/);
  assert.match(replyForTestFix({ state: "no-change" }).text, /no change has been applied/);
  assert.match(replyForTestFix({ state: "wrong-workflow", expected: "a", given: "b" }).text, /“a”, not “b”/);
  assert.equal(replyForTestFix({ state: "failed" }).isError, true);
  assert.match(replyForTestFix({ state: "failed" }).text, /Docker Desktop/);
  assert.match(replyForTestUpdate({ state: "applied", updates: [UPD] }).text, /now expects “OLALA: x” \(it used to expect “ALERT: x”\)/);
  assert.equal(replyForTestUpdate({ state: "write-failed" }).isError, true);
});

// ---------- sending a change for review ----------
const SUBMIT_FACTS_PLAIN = { workflowChanged: true, newWorkflow: false, workflowChanges: CHANGES, tests: [{ status: "A", name: "New test" }, { status: "D", name: "Old test" }, { status: "M", name: null }] };

test("a ready preview lists the workflow changes and every test in plain words, with the code only for the assistant", () => {
  const r = replyForSubmitPreview({ state: "ready", testsChanged: true, testsRemoved: false, noTestReason: null }, SUBMIT_FACTS_PLAIN, "424242");
  assert.match(r.text, /changed from “ALERT: down” to “TEST: down”/);
  assert.match(r.text, /A new test: “New test”/);
  assert.match(r.text, /The test “Old test” was removed/);
  assert.match(r.text, /The test a test was changed|a test was changed/);
  assert.match(forPerson(r.text), /Nothing has been sent yet/);
  assert.doesNotMatch(forPerson(r.text), /424242/);
  assert.match(r.text, /For you, the assistant.*424242/s);
});

test("removed tests and a brand new workflow are said plainly", () => {
  assert.match(replyForSubmitPreview({ state: "ready", testsChanged: true, testsRemoved: true, noTestReason: null }, SUBMIT_FACTS_PLAIN, "1").text, /Tests were removed/);
  assert.match(replyForSubmitPreview({ state: "ready", testsChanged: false, testsRemoved: false, noTestReason: null }, { newWorkflow: true, workflowChanged: true, tests: [] }, "1").text, /A brand new workflow/);
});

test("every reason a change cannot be sent has a plain sentence, and only Git problems are errors", () => {
  const all = ["editor-open", "editor-unknown", "no-check", "check-stale", "check-failed", "no-change", "other-files", "workflow-without-test", "reason-too-long", "no-git", "no-repo", "no-base", "no-facts", "something-new"];
  for (const code of all) {
    const r = replyForSubmitPreview({ state: "blocked", reasons: [{ code, count: 2 }] }, {}, undefined);
    assert.ok(forPerson(r.text).length > 40, code);
    assert.equal(r.isError, ["no-git", "no-repo", "no-base", "no-facts"].includes(code), code);
  }
  assert.match(replyForSubmitPreview({ state: "blocked", reasons: [{ code: "other-files", count: 2 }] }, {}).text, /2 other files changed/);
  assert.match(replyForSubmitPreview({ state: "blocked", reasons: [{ code: "no-check" }] }, {}).text, /call check_workflow/);
});

// ---------- sending ----------
test("a sent change gives the review link, says it is not live yet, and keeps technical details out of sight", () => {
  const link = "https://github.com/acme/flows/pull/new/n8n-dev/demo-20261018-0705";
  const r = replyForSend({ state: "sent" }, link);
  assert.equal(r.isError, false);
  assert.match(r.text, /Sent for review\. It is not live/);
  assert.match(r.text, new RegExp(link.replace(/[/.]/g, "\\$&")));
  assert.match(replyForSend({ state: "sent" }, null).text, /let a colleague know/);
});

test("each way sending can fail has a plain reply; only 'nothing to send' is not an error", () => {
  for (const state of ["nothing", "push-failed", "no-identity", "no-remote", "no-git", "no-repo", "no-base", "failed", "bad-branch"]) {
    const r = replyForSend({ state, details: "fatal: could not read Username for 'https://github.com'" }, null);
    assert.ok(forPerson(r.text).length > 30, state);
    assert.equal(r.isError, state !== "nothing", state);
  }
  assert.match(replyForSend({ state: "push-failed", details: "fatal: x" }).text, /Technical details \(for support\): fatal: x/);
  assert.doesNotMatch(forPerson(replyForSend({ state: "push-failed", details: "fatal: x" }).text), /fatal/);
});

test("a refused send tells the assistant to wait for the person", () => {
  for (const why of ["too-soon", "no-words"]) {
    const r = replyForSubmitRefused(why);
    assert.equal(r.isError, true);
    assert.match(r.text, /For you, the assistant/);
  }
  assert.match(forPerson(replyForSubmitRefused("too-soon").text), /go-ahead first/);
});

test("the ready preview asks the person and tells the assistant to stop and wait before calling submit", () => {
  const r = replyForSubmitPreview({ state: "ready", testsChanged: false, testsRemoved: false, noTestReason: null }, { workflowChanged: true, workflowChanges: CHANGES, tests: [] }, "909090");
  assert.match(forPerson(r.text), /If you'd like me to send it for review, say so/);
  assert.match(r.text, /For you, the assistant.*STOP.*submit.*theirWords/s);
  assert.match(forPerson(replyForSubmitPreview({ state: "ready", testsChanged: false, testsRemoved: false, noTestReason: null }, { workflowChanged: true, workflowChanges: CHANGES, tests: [], fetched: false }, "1").text), /couldn't reach the team's repository/);
});

test("the new reasons a change cannot go are plain and not errors", () => {
  for (const code of ["shared-changed", "open-submission", "rate-limit"]) {
    const r = replyForSubmitPreview({ state: "blocked", reasons: [{ code, max: 3 }] }, {});
    assert.equal(r.isError, false, code);
    assert.ok(forPerson(r.text).length > 60, code);
  }
  assert.match(replyForSubmitPreview({ state: "blocked", reasons: [{ code: "rate-limit", max: 3 }] }, {}).text, /already sent 3 changes/);
});

// ---------- what an earlier editor left behind ----------
const LEFTOVER = { kind: "editor-stopped", workflow: "flows/demo", drift: false, changes: 2, ageMs: 5 * 3600_000, age: "about 5 hours ago", stale: false };

test("an offer says what was found, how old it is, and the choices, with the tool names only for the assistant", () => {
  const r = replyForSession(LEFTOVER);
  assert.match(forPerson(r.text), /A test editor from about 5 hours ago was stopped/);
  assert.match(forPerson(r.text), /bring it back so you can carry on, close it and keep your changes, or throw it away/);
  assert.doesNotMatch(forPerson(r.text), /ui_resume|ui_stop|ui_discard/);
  assert.match(r.text, /For you, the assistant.*ui_resume.*ui_stop.*ui_discard/s);
});

test("a missing age is said as 'earlier', and an unknown kind is not an offer", () => {
  assert.match(replyForSession({ ...LEFTOVER, age: null }).text, /from earlier was stopped/);
  assert.equal(describeOffer({ kind: "none" }), null);
  assert.match(replyForSession({ kind: "none" }).text, /nothing is waiting from earlier/);
  assert.equal(replyForSession({ kind: "unknown" }).isError, true);
  assert.match(replyForSession({ kind: "editor-orphan", drift: null, changes: null }).text, /close it, or throw it away/);
});

test("stale and drifted leftovers are described honestly and the carry-on choice is withdrawn when it cannot work", () => {
  assert.match(describeOffer({ ...LEFTOVER, stale: true, age: "5 days ago" }).text, /Throwing it away is usually the safe choice/);
  const drifted = describeOffer({ ...LEFTOVER, drift: true });
  assert.match(drifted.text, /may no longer fit it/);
  assert.doesNotMatch(drifted.text, /bring it back/);
  assert.doesNotMatch(drifted.hint, /ui_resume/);
  assert.match(describeOffer({ ...LEFTOVER, kind: "saved-edits", changes: 1 }).text, /1 change from about 5 hours ago that were saved/);
  assert.match(describeOffer({ ...LEFTOVER, kind: "saved-edits", drift: true }).hint, /it will refuse, the workflow moved/);
});

test("a refused start offers the choices; without a session it falls back to the plain reply", () => {
  const refused = replyForStartRefused({ state: "already-running", session: LEFTOVER });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /haven't opened a new editor, because there is already something from before/);
  assert.equal(replyForStartRefused({ state: "already-running" }), null);
});

test("bringing an editor back, and throwing one away, are said plainly", () => {
  const back = replyForResume({ state: "resumed", address: "http://127.0.0.1:5678", login: { email: "a@b.c", password: "p" } });
  assert.match(back.text, /Your earlier test editor is back, with your changes in it/);
  assert.match(back.text, /For you, the assistant.*STOP/s);
  assert.match(replyForResume({ state: "drifted", session: { ...LEFTOVER, drift: true } }).text, /haven't brought it back/);
  assert.equal(replyForResume({ state: "nothing-to-resume" }).isError, true);
  assert.equal(replyForDiscard({ state: "discarded", cleaned: true }).isError, false);
  assert.equal(replyForDiscard({ state: "discarded", cleaned: false }).isError, true);
  assert.match(replyForDiscard({ state: "no-words" }).text, /Say the word/);
  assert.equal(replyForDiscard({ state: "whatever" }).isError, true);
});

// ---------- tests written from the person's own words ----------
const DRAFT_TEST = { name: "Down site", when: { trigger: { site: "docs", n: 2, ok: true, nested: { a: 1 } }, services: { "Check status": [{ status: "down", latency_ms: 1200 }, { status: "up" }] } },
  then: [{ step: "Send alert", runs: 1 }, { step: "Send alert", runs: 3 }, { step: "Ignore", doesNotRun: true }, { step: "Compose", field: "reminder_count", side: "output", is: 3 },
    { step: "Compose", field: "text", isNot: "x" }, { step: "Compose", field: "a.b", contains: "y" }, { endsAt: "Send alert" }], unmocked: ["Send alert"] };
const DRAFT = { state: "ready", tests: [DRAFT_TEST] };

test("a test is described in plain when/then sentences for every kind of check", () => {
  const { when, then } = describeWhenThen(DRAFT_TEST);
  assert.equal(when[0], "A request comes in with site = “docs”, n = 2, ok = true, nested = {\"a\":1}");
  assert.equal(when[1], "“Check status” answers with status = “down”, latency ms = 1200, and then with status = “up”");
  assert.deepEqual(then, [
    "“Send alert” runs once", "“Send alert” runs 3 times", "“Ignore” does not run",
    "The reminder count going out of “Compose” is 3", "The text going into “Compose” is not “x”", "The a b going into “Compose” contains “y”",
    "The workflow finishes at “Send alert”",
  ]);
  assert.equal(describeWhenThen({ when: {}, then: [] }).when[0], "A request comes in");
});

test("a long value is shortened, not dumped", () => {
  const long = { when: { trigger: { blob: { text: "x".repeat(200) } } }, then: [] };
  assert.ok(describeWhenThen(long).when[0].length < 120);
  assert.match(describeWhenThen(long).when[0], /…$/);
});

test("the preview keeps the code for the assistant and the person's words in front of the person", () => {
  const r = replyForDraftPreview(DRAFT, "737373", "When a site is down, alert.");
  assert.match(forPerson(r.text), /You said: “When a site is down, alert\.”/);
  assert.match(forPerson(r.text), /Nothing has been added yet/);
  assert.doesNotMatch(forPerson(r.text), /737373|draft_test_save/);
  assert.match(r.text, /For you, the assistant.*737373.*STOP.*draft_test_save.*theirWords/s);
  assert.doesNotMatch(replyForDraftPreview({ ...DRAFT, tests: [{ ...DRAFT_TEST, unmocked: [] }] }, "1", "w").text, /no pretend answer/);
});

test("every way a described test can be refused has a plain sentence, and the format for the assistant", () => {
  const errors = [
    { code: "bad-name" }, { code: "name-taken", name: "X" }, { code: "unknown-step", step: "Y", steps: ["A", "B"] }, { code: "not-outside", step: "Z", outside: ["A"] },
    { code: "empty-then" }, { code: "too-many-checks", max: 10 }, { code: "duplicate-check" }, { code: "step-name-unsupported", step: 'a"b' },
    { code: "too-many-tests", max: 30 }, { code: "no-words" },
  ];
  for (const e of errors) {
    const r = replyForDraftPreview({ state: "invalid", errors: [e] }, undefined, undefined);
    assert.match(forPerson(r.text), /can't add that test yet/, e.code);
    assert.ok(forPerson(r.text).length > 40, e.code);
    assert.match(r.text, /For you, the assistant.*"then"/s, e.code);
  }
  assert.match(replyForDraftPreview({ state: "invalid", errors: [{ code: "bad-json" }, { code: "bad-trigger" }] }).text, /adjust how I've described the test/);
  assert.equal(replyForDraftPreview({ state: "nope" }).isError, true);
});

test("saving, refusing and removing are said plainly", () => {
  assert.match(replyForDraftSaved({ state: "added", tests: [{ name: "Down site", file: "04-x.yaml" }] }).text, /Added the test “Down site”.*fail until your workflow does this/s);
  assert.match(replyForDraftSaved({ state: "added", tests: [{ name: "Down site", file: "04-x.yaml" }] }).text, /For you, the assistant.*ui_start/s);
  assert.match(replyForDraftSaved({ state: "invalid", errors: [{ code: "name-taken", name: "X" }] }).text, /already a test called/);
  assert.equal(replyForDraftSaved({ state: "failed" }).isError, true);
  assert.match(forPerson(replyForDraftRefused("too-soon").text), /go-ahead first/);
  assert.match(forPerson(replyForDraftRefused("no-words").text), /need to hear from you/);
  for (const [state, isError] of [["removed", false], ["already-gone", false], ["not-drafted", true], ["changed-since", true], ["bad-file", true], ["other", true]]) {
    assert.equal(replyForDraftRemoved({ state, file: "04-x.yaml", name: "Down site" }).isError, isError, state);
  }
});

// ---------- several tests at once, stale codes, edits already applied ----------
const TWO = { state: "ready", tests: [DRAFT_TEST, { ...DRAFT_TEST, name: "Second test", unmocked: [] }] };

test("several tests are shown one after the other, with one question for the whole set", () => {
  const r = replyForDraftPreview(TWO, "818181", "Slow sites should alert; just under the line should not.");
  assert.match(forPerson(r.text), /Here are the 2 tests I would add/);
  assert.match(forPerson(r.text), /Test 1: “Down site”/);
  assert.match(forPerson(r.text), /Test 2: “Second test”/);
  assert.match(forPerson(r.text), /In test 1, these steps talk to outside services/);
  assert.doesNotMatch(forPerson(r.text), /In test 2, these steps/, "only the test that needs an answer is flagged");
  assert.match(forPerson(r.text), /I'll add them all/);
  assert.doesNotMatch(forPerson(r.text), /818181/);
  assert.match(r.text, /For you, the assistant.*with the WHOLE set.*never preview and save in the same step/s);
  assert.match(replyForDraftPreview({ state: "ready", tests: [DRAFT_TEST] }, "1", "w").text, /Here is the test I would add/);
});

test("problems in a set name the test they belong to", () => {
  const r = replyForDraftPreview({ state: "invalid", count: 3, errors: [{ code: "unknown-step", step: "Y", steps: ["A"], index: 2, testName: "Third" }, { code: "name-taken", name: "X", index: 0, testName: null }] });
  assert.match(forPerson(r.text), /can't add those tests yet/);
  assert.match(forPerson(r.text), /Test 3 \(“Third”\): There is no step called “Y”/);
  assert.match(forPerson(r.text), /Test 1: There is already a test called “X”/);
  const single = replyForDraftPreview({ state: "invalid", count: 1, errors: [{ code: "unknown-step", step: "Y", steps: ["A"], index: 0, testName: "Only" }] });
  assert.doesNotMatch(forPerson(single.text), /Test 1/, "a single test is not numbered");
  assert.match(forPerson(replyForDraftPreview({ state: "invalid", errors: [{ code: "too-many-in-preview", max: 6 }] }).text), /more than 6 tests at once/);
});

test("a saved set lists every test, and a single test keeps the short wording", () => {
  const r = replyForDraftSaved({ state: "added", tests: [{ name: "One", file: "02-one.yaml" }, { name: "Two", file: "03-two.yaml" }] });
  assert.match(forPerson(r.text), /Added 2 tests:/);
  assert.match(forPerson(r.text), /“One”/);
  assert.match(forPerson(r.text), /“Two”/);
  assert.match(r.text, /For you, the assistant.*02-one\.yaml, 03-two\.yaml/s);
  assert.match(forPerson(replyForDraftSaved({ state: "added", tests: [{ name: "Solo", file: "02-solo.yaml" }] }).text), /^Added the test “Solo”\./);
});

test("an old or replaced preview is explained to the person plainly, and to the assistant firmly", () => {
  const r = replyForStaleCode("changes", "pull_preview", "That code has expired. Preview again to get a new one.");
  assert.equal(r.isError, true);
  assert.match(forPerson(r.text), /That preview of the changes is out of date, so I need to show it to you again before anything happens\./);
  assert.doesNotMatch(forPerson(r.text), /expired|pull_preview/);
  assert.match(r.text, /For you, the assistant.*expired.*Call pull_preview again.*STOP.*Never preview and save in the same step/s);
  assert.match(replyForStaleCode("test", "draft_test_preview", undefined).text, /The code no longer works/);
});

test("edits that were already applied are said plainly, and are not an error", () => {
  const r = replyForPreview({ state: "already-applied", workflow: "flows/demo" });
  assert.equal(r.isError, false);
  assert.match(r.text, /already applied to your workflow, so there is nothing waiting/);
});
