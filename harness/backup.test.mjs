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
  assert.deepEqual(decideUndo({ record: record(), currentText: AFTER }), { state: "restore", text: BEFORE });
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
