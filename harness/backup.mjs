// The safety net behind "undo". Every apply first keeps a copy of the file it is about to overwrite, together with what it
// changed. Undo puts that copy back, but only if nobody has touched the file since: it never overwrites someone's newer
// work. Pure functions, no I/O: n8n-dev.mjs does the reading and writing. Nothing here knows about any one workflow.
import { createHash } from "node:crypto";

export const textHash = (text) => createHash("sha256").update(String(text)).digest("hex");

// A record of one apply: where it wrote, what the file said before, a fingerprint of what it wrote, and what changed.
export function makeRecord({ workflowFile, workflowDir, before, after, changes, at }) {
  return { workflowFile, workflowDir, before, afterHash: textHash(after), changes: changes ?? [], at };
}

// Only a path inside the repository may ever be written by an undo, even if the record file was tampered with.
export function safeRelative(p) {
  if (typeof p !== "string" || !p) return false;
  if (/^([a-zA-Z]:|[\\/])/.test(p)) return false;                 // absolute, drive letter or rooted
  return !p.split(/[\\/]+/).includes("..");
}

// What an undo should do, given the saved record and what the file says now (undefined if it is gone).
export function decideUndo({ record, currentText }) {
  if (!record || typeof record.before !== "string" || !record.afterHash || !safeRelative(record.workflowFile)) return { state: "nothing-to-undo" };
  if (currentText === undefined) return { state: "missing" };
  if (textHash(currentText) === textHash(record.before)) return { state: "already-undone" };
  if (textHash(currentText) !== record.afterHash) return { state: "changed-since" };
  return { state: "restore", text: record.before };
}
