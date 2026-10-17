// Tests for harness/testfix.mjs. No files, no Docker.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { segmentOf, segmentsFromChanges, explainCheck, planTestUpdates, rewriteTestText } from "./testfix.mjs";

const TEMPLATE_OLD = "ALERT: {{ $('Health check request').first().json.body.site }} is not healthy (status: {{ $json.status }})";
const TEMPLATE_NEW = "OLALA: {{ $('Health check request').first().json.body.site }} is not healthy (status: {{ $json.status }})";
const CHANGES = [{ kind: "changed", node: "Compose alert", details: [{ label: "text", from: TEMPLATE_OLD, to: TEMPLATE_NEW }] }];
const SEG = [{ from: "ALERT:", to: "OLALA:" }];
const failing = (assertion, got) => ({ assertion, pass: false, detail: `input.text = ${JSON.stringify(got)}` });
const CONTAINS = 'node "Send alert" input.text contains "ALERT: docs is not healthy (status: down)"';

test("segmentOf finds only the piece that differs", () => {
  assert.deepEqual(segmentOf(TEMPLATE_OLD, TEMPLATE_NEW), { from: "ALERT", to: "OLALA" });
  assert.deepEqual(segmentOf("a1b", "a22b"), { from: "1", to: "22" });
  assert.equal(segmentOf("same", "same"), null);
  assert.equal(segmentOf("ab", "aXb"), null, "a pure insertion has nothing to find");
  assert.deepEqual(segmentOf("abc", "ab"), { from: "c", to: "" });
  assert.equal(segmentOf(1, 2), null);
});

test("segments are taken from changed text only", () => {
  assert.deepEqual(segmentsFromChanges(CHANGES), [{ from: "ALERT", to: "OLALA" }]);
  assert.deepEqual(segmentsFromChanges([{ kind: "added", node: "x" }, { kind: "changed", node: "n", details: [{ label: "n", from: 1, to: 2 }] }]), []);
  assert.deepEqual(segmentsFromChanges(undefined), []);
});

test("a check that expected the old wording is explained, and gets the exact new line", () => {
  const e = explainCheck(failing(CONTAINS, "OLALA: docs is not healthy (status: down)"), SEG);
  assert.equal(e.kind, "explained");
  assert.equal(e.to, "OLALA: docs is not healthy (status: down)");
  assert.equal(e.newAssertion, 'node "Send alert" input.text contains "OLALA: docs is not healthy (status: down)"');
});

test("an exact-match check is explained the same way", () => {
  const a = 'node "Compose alert" output.text == "ALERT: docs is not healthy"';
  const e = explainCheck(failing(a, "OLALA: docs is not healthy"), SEG);
  assert.equal(e.kind, "explained");
  assert.equal(e.newAssertion, 'node "Compose alert" output.text == "OLALA: docs is not healthy"');
});

test("control: a failure the change does not explain is never touched", () => {
  // the test expects the old wording and the workflow produces the NEW wording, so the swap explains it ...
  assert.equal(explainCheck(failing(CONTAINS, "OLALA: docs is not healthy (status: down)"), SEG).kind, "explained");
  // ... but if the workflow also produces something else, the swap does not give what really happens
  assert.equal(explainCheck(failing(CONTAINS, "OLALA: docs is BROKEN"), SEG).reason, "mismatch");
  // the expectation does not mention the changed text at all
  assert.equal(explainCheck(failing('node "Send alert" input.text contains "docs is fine"', "something else"), SEG).reason, "unrelated");
  // equality that would still not match
  assert.equal(explainCheck(failing('node "N" output.text == "ALERT: x"', "OLALA: y"), SEG).reason, "mismatch");
});

test("checks that are not about text, or have no actual value, are never explained", () => {
  assert.equal(explainCheck({ assertion: 'node "Send alert" called 1 time', pass: false, detail: "called 0 time(s)" }, SEG).reason, "not-text");
  assert.equal(explainCheck({ assertion: 'node "N" output.text != "ALERT"', pass: false, detail: 'output.text = "ALERT"' }, SEG).reason, "not-text");
  assert.equal(explainCheck({ assertion: CONTAINS, pass: false, detail: "node was never reached" }, SEG).reason, "no-actual");
  assert.equal(explainCheck({ assertion: CONTAINS, pass: false, detail: "input.text = 5" }, SEG).reason, "no-actual");
  assert.equal(explainCheck({ assertion: 'node "N" input.n contains 5', pass: false, detail: 'input.n = "x"' }, SEG).reason, "not-text");
});

test("the plan separates updatable lines from failures that need a person who knows the tests", () => {
  const tests = [
    { file: "01.yaml", name: "Down", pass: false, checks: [{ assertion: 'node "Send alert" called 1 time', pass: true }, failing(CONTAINS, "OLALA: docs is not healthy (status: down)")] },
    { file: "02.yaml", name: "Healthy", pass: true, checks: [] },
    { file: "03.yaml", name: "Broken", pass: false, error: "Workflow failed at X", checks: [] },
    { file: "04.yaml", name: "Other", pass: false, checks: [{ assertion: 'node "Send alert" called 1 time', pass: false, detail: "called 0 time(s)" }] },
  ];
  const p = planTestUpdates({ tests, changes: CHANGES });
  assert.equal(p.updates.length, 1);
  assert.equal(p.updates[0].file, "01.yaml");
  assert.deepEqual(p.unexplained.map((u) => [u.test, u.reason]), [["Broken", "error"], ["Other", "not-text"]]);
  assert.deepEqual(planTestUpdates({ tests, changes: [] }).updates, [], "with no text change recorded nothing can be explained");
});

test("rewriting keeps the rest of the file and fails loudly when the line is not there", () => {
  const text = "test: x\n# keep me\nassert:\n  - 'a ALERT: b'\n";
  const replace = (t, o, n) => (t.includes(o) ? t.replace(o, n) : null);
  assert.equal(rewriteTestText(text, [{ oldAssertion: "a ALERT: b", newAssertion: "a OLALA: b" }], replace).text, "test: x\n# keep me\nassert:\n  - 'a OLALA: b'\n");
  assert.match(rewriteTestText(text, [{ oldAssertion: "missing", newAssertion: "z" }], replace).error, /could not find: missing/);
  assert.match(rewriteTestText(text, [{ oldAssertion: "a ALERT: b", newAssertion: "a ALERT: b" }], (t) => t).error, /could not find/);
});
