// The rules for sending a finished change for review. Pure: no files, no Git, no clock of its own.
// n8n-dev.mjs `submit-facts` reports what differs from the shared version; this decides whether that may be sent.
// A change goes only when there is evidence: a passing check on exactly this content, a real difference, the editor
// closed, nothing in the way but the workflow and its own tests, a test that goes with any change to the workflow,
// the shared version of this workflow unchanged since the person's copy was taken, no earlier submission still
// waiting, and not too many sent in the last hour.
import { isValidWorkflowName } from "./guards.mjs";

const REASON_MAX = 300;
export const MAX_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

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

// The note that travels with the change. Plain, and it carries the person's reason when no test changed.
export function commitMessage(workflow, { testsChanged = false, testsRemoved = false, noTestReason = null } = {}) {
  const lines = [`Update ${workflow}`, "", "Sent for review with n8n-dev."];
  if (testsRemoved) lines.push("Tests were removed: please check why.");
  else if (testsChanged) lines.push("Tests were changed: please read them closely.");
  if (noTestReason) lines.push(`No test changed. Reason given: ${noTestReason}`);
  return lines.join("\n");
}

// The page where a reviewer is asked to look at the new branch, built from the repository's address. Only GitHub
// addresses get a link; anything else, or anything odd, gets none. Any login inside the address is dropped.
export function compareUrl(remoteUrl, branch) {
  const m = String(remoteUrl ?? "").trim().match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/\s]+@)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m || !/^n8n-dev\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(branch))) return null;
  return `https://github.com/${m[1]}/${m[2]}/pull/new/${branch}`;
}

// facts          what `submit-facts` printed
// check          the remembered result of the last check for this workflow: { passed, hash }, or undefined
// currentHash    fingerprint of the workflow and its tests right now
// editorOpen     true if a test editor is still open, "unknown" if that could not be told, false if none is open
// reason         the person's stated reason for a change to the workflow with no test change (optional)
// now            the current time as a Date, for the hourly limit
export function decideSubmit({ facts, check, currentHash, editorOpen, reason, now = new Date() }) {
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
  if (facts.sharedChanged) problems.push({ code: "shared-changed" });
  const submissions = Array.isArray(facts.submissions) ? facts.submissions : [];
  if (submissions.some((s) => s.workflow === dir && s.open)) problems.push({ code: "open-submission" });
  const recent = submissions.filter((s) => now.getTime() - Date.parse(s.at) < HOUR_MS);     // an unreadable date counts as not recent
  if (recent.length >= MAX_PER_HOUR) problems.push({ code: "rate-limit", max: MAX_PER_HOUR });

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
