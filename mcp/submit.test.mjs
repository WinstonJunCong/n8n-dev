// Tests for mcp/submit.mjs: every gate on sending a change for review. No Git, no Docker.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { branchName, decideSubmit, isWorkflowFile, isTestFile } from "./submit.mjs";

const DIR = "workflows/demo";
const WF = `${DIR}/workflow.json`, T1 = `${DIR}/tests/01.yaml`;
const facts = (files, extra = {}) => ({ state: "facts", base: "origin/main", dir: DIR, files, workflowChanged: files.some((f) => f.path === WF), newWorkflow: false, workflowChanges: [], tests: [], ...extra });
const GOOD_CHECK = { passed: true, hash: "h1" };
const ready = (over = {}) => decideSubmit({ facts: facts([{ path: WF, status: "M" }, { path: T1, status: "M" }]), check: GOOD_CHECK, currentHash: "h1", editorOpen: false, ...over });
const codes = (d) => d.reasons.map((r) => r.code);

test("a change with a passing check, a real difference, and a test goes", () => {
  const d = ready();
  assert.equal(d.state, "ready");
  assert.equal(d.testsChanged, true);
  assert.equal(d.testsRemoved, false);
  assert.equal(d.noTestReason, null);
});

test("control: each gate on its own turns a ready change into a refusal", () => {
  assert.equal(ready().state, "ready");
  assert.deepEqual(codes(ready({ editorOpen: true })), ["editor-open"]);
  assert.deepEqual(codes(ready({ check: undefined })), ["no-check"]);
  assert.deepEqual(codes(ready({ currentHash: "h2" })), ["check-stale"]);
  assert.deepEqual(codes(ready({ check: { passed: false, hash: "h1" } })), ["check-failed"]);
  assert.deepEqual(codes(ready({ facts: facts([{ path: WF, status: "M" }, { path: `${DIR}/notes.txt`, status: "A" }, { path: T1, status: "M" }]) })), ["other-files"]);
});

test("a check only counts for the exact content it ran on", () => {
  // the check passed, but the workflow or a test changed afterwards, so the fingerprint no longer matches
  assert.deepEqual(codes(ready({ check: { passed: true, hash: "older" } })), ["check-stale"]);
});

test("nothing different from the shared version is refused, and says so first", () => {
  const d = decideSubmit({ facts: facts([]), check: GOOD_CHECK, currentHash: "h1", editorOpen: false });
  assert.deepEqual(codes(d), ["no-change"]);
  const withProblems = decideSubmit({ facts: facts([]), check: undefined, currentHash: "h1", editorOpen: true });
  assert.deepEqual(codes(withProblems), ["editor-open", "no-check", "no-change"]);
});

test("a workflow change with no test change needs a stated reason", () => {
  const only = facts([{ path: WF, status: "M" }]);
  const base = { facts: only, check: GOOD_CHECK, currentHash: "h1", editorOpen: false };
  assert.deepEqual(codes(decideSubmit(base)), ["workflow-without-test"]);
  assert.deepEqual(codes(decideSubmit({ ...base, reason: "   " })), ["workflow-without-test"]);
  assert.deepEqual(codes(decideSubmit({ ...base, reason: "x".repeat(301) })), ["reason-too-long"]);
  const ok = decideSubmit({ ...base, reason: "Only a typo in a label" });
  assert.equal(ok.state, "ready");
  assert.equal(ok.noTestReason, "Only a typo in a label");
  assert.equal(ok.testsChanged, false);
});

test("a reason is not needed, and is not recorded, when a test changed too", () => {
  const d = ready({ reason: "not needed" });
  assert.equal(d.state, "ready");
  assert.equal(d.noTestReason, null);
});

test("a test-only change is allowed, and removed tests are flagged", () => {
  const removed = decideSubmit({ facts: facts([{ path: T1, status: "D" }]), check: GOOD_CHECK, currentHash: "h1", editorOpen: false });
  assert.equal(removed.state, "ready");
  assert.equal(removed.testsRemoved, true);
});

test("only the workflow and its own tests may be sent: anything else in the folder, or outside it, blocks", () => {
  for (const extra of [`${DIR}/README.md`, `${DIR}/tests/sub/x.yaml`, `${DIR}/tests/x.txt`, "config/readiness.json", "workflows/other/workflow.json", `${DIR}/../x`]) {
    const d = decideSubmit({ facts: facts([{ path: WF, status: "M" }, { path: T1, status: "M" }, { path: extra, status: "M" }]), check: GOOD_CHECK, currentHash: "h1", editorOpen: false });
    assert.deepEqual(codes(d), ["other-files"], extra);
  }
  assert.equal(isWorkflowFile(DIR, WF), true);
  assert.equal(isWorkflowFile(DIR, `${DIR}/x/workflow.json`), false);
  assert.equal(isTestFile(DIR, T1), true);
  assert.equal(isTestFile(DIR, `${DIR}/tests/a/b.yaml`), false);
  assert.equal(isTestFile(DIR, `${DIR}/testsx/b.yaml`), false);
});

test("when Git cannot answer, nothing goes and the reason is the Git problem", () => {
  for (const state of ["no-git", "no-repo", "no-base"]) {
    assert.deepEqual(codes(decideSubmit({ facts: { state }, check: GOOD_CHECK, currentHash: "h1", editorOpen: false })), [state]);
  }
  assert.deepEqual(codes(decideSubmit({ facts: undefined, check: GOOD_CHECK, currentHash: "h1", editorOpen: false })), ["no-facts"]);
});

test("a submission is always on a new branch named after the workflow, never the shared one", () => {
  const at = new Date(Date.UTC(2026, 9, 18, 7, 5));
  assert.deepEqual(branchName("site-health-alert", at), { branch: "n8n-dev/site-health-alert-20261018-0705" });
  for (const bad of ["main", "../x", "a b", "", "a;b", "a/b", "-x"]) {
    const r = branchName(bad, at);
    assert.ok(r.error || (r.branch.startsWith("n8n-dev/") && !/^n8n-dev\/main$/.test(r.branch)), bad);
  }
  assert.ok(branchName("../x", at).error);
  assert.ok(branchName("ok", new Date("nope")).error);
  assert.ok(branchName("ok", "2026-10-18").error);
});
