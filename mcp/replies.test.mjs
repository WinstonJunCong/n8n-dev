// Tests for mcp/replies.mjs: what the person reads. No Docker, no processes.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  JARGON, describeChanges, describeNotApplied, plainAssertion,
  replyForCheck, replyForStart, replyForStop, replyForStopRefused, replyForUndo, describeUndone, replyForPreview, replyForApply, replyForStatus,
} from "./replies.mjs";

// The part of a reply meant for the person: without the line for the assistant and the support details.
const forPerson = (text) => text.split("For you, the assistant")[0].split("Technical details (for support)")[0];
// "Docker Desktop" is a program the person has to open, so its name is allowed; nothing else technical is.
const lintable = (text) => forPerson(text).replace(/Docker Desktop/g, "");

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
