// The rules for sending a finished change for review. Pure: no files, no Git, no clock of its own.
// n8n-dev.mjs `submit-facts` reports what differs from the shared version; this decides whether that may be sent.
// A change goes only when there is evidence: a passing check on exactly this content, a real difference, the editor
// closed, nothing in the way but the workflow and its own tests, and a test that goes with any change to the workflow.
import { isValidWorkflowName } from "./guards.mjs";

const REASON_MAX = 300;

export const isWorkflowFile = (dir, p) => p === `${dir}/workflow.json`;
export const isTestFile = (dir, p) => p.startsWith(`${dir}/tests/`) && /\.ya?ml$/.test(p) && !p.slice(dir.length + 7).includes("/");

// Where a submission is pushed: a new branch, never the shared one. Rejects anything that is not a plain workflow name.
export function branchName(workflow, date) {
  if (!isValidWorkflowName(workflow)) return { error: "That is not a workflow name." };
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return { error: "A date is needed." };
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
  return { branch: `n8n-dev/${workflow}-${stamp}` };
}

// facts          what `submit-facts` printed
// check          the remembered result of the last check for this workflow: { passed, hash }, or undefined
// currentHash    fingerprint of the workflow and its tests right now
// editorOpen     true if a test editor is still open, "unknown" if that could not be told, false if none is open
// reason         the person's stated reason for a change to the workflow with no test change (optional)
export function decideSubmit({ facts, check, currentHash, editorOpen, reason }) {
  const blocked = (...reasons) => ({ state: "blocked", reasons });
  if (!facts || facts.state !== "facts") return blocked({ code: facts?.state ?? "no-facts" });
  const problems = [];
  if (editorOpen === "unknown") problems.push({ code: "editor-unknown" });
  else if (editorOpen) problems.push({ code: "editor-open" });
  if (!check) problems.push({ code: "no-check" });
  else if (check.hash !== currentHash) problems.push({ code: "check-stale" });
  else if (!check.passed) problems.push({ code: "check-failed" });
  if (!facts.files.length) return blocked(...problems, { code: "no-change" });

  const dir = facts.dir;
  const other = facts.files.filter((f) => !isWorkflowFile(dir, f.path) && !isTestFile(dir, f.path));
  if (other.length) problems.push({ code: "other-files", count: other.length });

  const tests = facts.files.filter((f) => isTestFile(dir, f.path));
  const why = typeof reason === "string" ? reason.trim() : "";
  if (facts.workflowChanged && !tests.length) {
    if (!why) problems.push({ code: "workflow-without-test" });
    else if (why.length > REASON_MAX) problems.push({ code: "reason-too-long" });
  }
  if (problems.length) return blocked(...problems);
  return {
    state: "ready",
    testsChanged: tests.length > 0,
    testsRemoved: tests.some((t) => t.status === "D"),
    noTestReason: facts.workflowChanged && !tests.length ? why : null,
  };
}
