// The safety net behind "undo". Every apply first keeps a copy of the file it is about to overwrite, together with what it
// changed. If test lines are updated afterwards, their old text is added to the same record, so one undo takes back the
// whole change. Undo puts the copies back, but only if nobody has touched those files since: it never overwrites someone's
// newer work. Pure functions, no I/O: n8n-dev.mjs does the reading and writing. Nothing here knows about any one workflow.
import { createHash } from "node:crypto";

export const textHash = (text) => createHash("sha256").update(String(text)).digest("hex");

// A record of one apply: where it wrote, what the file said before, a fingerprint of what it wrote, and what changed.
export function makeRecord({ workflowFile, workflowDir, before, after, changes, at }) {
  return { workflowFile, workflowDir, before, afterHash: textHash(after), changes: changes ?? [], tests: [], at };
}

// Adds updated test files to a record: each keeps its old text and a fingerprint of the new text.
export function addTestEdits(record, files) {
  const kept = new Map((record.tests ?? []).map((t) => [t.file, t]));
  for (const f of files) {
    const earlier = kept.get(f.file);
    kept.set(f.file, { file: f.file, before: earlier ? earlier.before : f.before, afterHash: textHash(f.after) });   // keep the oldest text
  }
  return { ...record, tests: [...kept.values()] };
}

// Only a path inside the repository may ever be written by an undo, even if the record file was tampered with.
export function safeRelative(p) {
  if (typeof p !== "string" || !p) return false;
  if (/^([a-zA-Z]:|[\\/])/.test(p)) return false;                 // absolute, drive letter or rooted
  return !p.split(/[\\/]+/).includes("..");
}

// What an undo should do, given the saved record and what the files say now (undefined if one is gone).
export function decideUndo({ record, currentText, currentTests = {} }) {
  const tests = Array.isArray(record?.tests) ? record.tests : [];
  if (!record || typeof record.before !== "string" || !record.afterHash || !safeRelative(record.workflowFile)) return { state: "nothing-to-undo" };
  if (tests.some((t) => typeof t.before !== "string" || !t.afterHash || !safeRelative(t.file))) return { state: "nothing-to-undo" };
  if (currentText === undefined) return { state: "missing" };
  const testsBack = tests.every((t) => currentTests[t.file] !== undefined && textHash(currentTests[t.file]) === textHash(t.before));
  if (textHash(currentText) === textHash(record.before) && testsBack) return { state: "already-undone" };
  const untouched = textHash(currentText) === record.afterHash || textHash(currentText) === textHash(record.before);
  const testsUntouched = tests.every((t) => currentTests[t.file] !== undefined
    && (textHash(currentTests[t.file]) === t.afterHash || textHash(currentTests[t.file]) === textHash(t.before)));
  if (!untouched || !testsUntouched) return { state: "changed-since" };
  return { state: "restore", text: record.before, tests: tests.map((t) => ({ file: t.file, text: t.before })) };
}
