// Tests for harness/backup.mjs: the rules for undoing an apply. No files, no Docker.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { makeRecord, decideUndo, safeRelative, textHash } from "./backup.mjs";

const BEFORE = '{"v":1}\n';
const AFTER = '{"v":2}\n';
const record = () => makeRecord({ workflowFile: "workflows/a/workflow.json", workflowDir: "workflows/a", before: BEFORE, after: AFTER, changes: [{ kind: "changed", node: "N", details: [] }], at: "2026-10-18T00:00:00Z" });

test("a record keeps the old text, a fingerprint of the new text, and what changed", () => {
  const r = record();
  assert.equal(r.before, BEFORE);
  assert.equal(r.afterHash, textHash(AFTER));
  assert.equal(r.changes.length, 1);
  assert.equal(makeRecord({ workflowFile: "x", before: "a", after: "b" }).changes.length, 0);
});

test("undo restores the old text when the file is exactly what the apply wrote", () => {
  assert.deepEqual(decideUndo({ record: record(), currentText: AFTER }), { state: "restore", text: BEFORE, tests: [] });
});

test("undo refuses when the file changed since the apply, so newer work is never overwritten", () => {
  assert.equal(decideUndo({ record: record(), currentText: '{"v":3}\n' }).state, "changed-since");
});

test("control: the same record restores for the exact text and refuses for a one-character difference", () => {
  assert.equal(decideUndo({ record: record(), currentText: AFTER }).state, "restore");
  assert.equal(decideUndo({ record: record(), currentText: AFTER + " " }).state, "changed-since");
});

test("undo says so when the file already has the old text, or is gone, or there is no record", () => {
  assert.equal(decideUndo({ record: record(), currentText: BEFORE }).state, "already-undone");
  assert.equal(decideUndo({ record: record(), currentText: undefined }).state, "missing");
  for (const bad of [null, undefined, {}, { before: 1 }, { ...record(), afterHash: "" }]) {
    assert.equal(decideUndo({ record: bad, currentText: AFTER }).state, "nothing-to-undo", JSON.stringify(bad));
  }
});

test("a record that points outside the repository is never acted on", () => {
  for (const workflowFile of ["../x.json", "a/../../x.json", "/etc/x", "C:\\x.json", "C:/x.json", "\\\\host\\share\\x", "", 5]) {
    assert.equal(decideUndo({ record: { ...record(), workflowFile }, currentText: AFTER }).state, "nothing-to-undo", String(workflowFile));
  }
  assert.equal(safeRelative("workflows/a/workflow.json"), true);
  assert.equal(safeRelative("workflows\\a\\workflow.json"), true);
});

// ---------- test files are part of the same undo ----------
import { addTestEdits } from "./backup.mjs";
const T_BEFORE = "assert: [old]\n", T_AFTER = "assert: [new]\n";
const withTests = () => addTestEdits(record(), [{ file: "workflows/a/tests/01.yaml", before: T_BEFORE, after: T_AFTER }]);

test("test files updated after an apply are saved in the same record", () => {
  const r = withTests();
  assert.equal(r.tests.length, 1);
  assert.equal(r.tests[0].before, T_BEFORE);
  assert.equal(r.tests[0].afterHash, textHash(T_AFTER));
  assert.equal(record().tests.length, 0);
  // updating the same file again keeps the OLDEST text, so undo goes back to before the whole change
  const again = addTestEdits(r, [{ file: "workflows/a/tests/01.yaml", before: T_AFTER, after: "assert: [newer]\n" }]);
  assert.equal(again.tests[0].before, T_BEFORE);
  assert.equal(again.tests[0].afterHash, textHash("assert: [newer]\n"));
});

test("undo puts the workflow and its updated tests back together", () => {
  const d = decideUndo({ record: withTests(), currentText: AFTER, currentTests: { "workflows/a/tests/01.yaml": T_AFTER } });
  assert.deepEqual(d, { state: "restore", text: BEFORE, tests: [{ file: "workflows/a/tests/01.yaml", text: T_BEFORE }] });
});

test("undo refuses if a test file was edited since, or is gone", () => {
  assert.equal(decideUndo({ record: withTests(), currentText: AFTER, currentTests: { "workflows/a/tests/01.yaml": "assert: [someone else]\n" } }).state, "changed-since");
  assert.equal(decideUndo({ record: withTests(), currentText: AFTER, currentTests: {} }).state, "changed-since");
});

test("control: with the test file as the update left it, the same record does restore", () => {
  assert.equal(decideUndo({ record: withTests(), currentText: AFTER, currentTests: { "workflows/a/tests/01.yaml": T_AFTER } }).state, "restore");
});

test("undo is 'already undone' only when the workflow and every test are back", () => {
  assert.equal(decideUndo({ record: withTests(), currentText: BEFORE, currentTests: { "workflows/a/tests/01.yaml": T_BEFORE } }).state, "already-undone");
  assert.equal(decideUndo({ record: withTests(), currentText: BEFORE, currentTests: { "workflows/a/tests/01.yaml": T_AFTER } }).state, "restore");
});

test("a test path outside the repository makes the whole record unusable", () => {
  const r = addTestEdits(record(), [{ file: "../evil.yaml", before: "x", after: "y" }]);
  assert.equal(decideUndo({ record: r, currentText: AFTER, currentTests: { "../evil.yaml": "y" } }).state, "nothing-to-undo");
});

test("a Windows path with backslashes cannot climb out of the repository either", () => {
  for (const p of ["a\\..\\x", "..\\x", "a\\b\\..\\..\\..\\x"]) assert.equal(safeRelative(p), false, p);
  assert.equal(safeRelative("a\\b\\c.json"), true);
});
