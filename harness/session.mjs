// The decisions behind `ui --detach` and `ui-stop`, kept as pure functions so they can be tested without Docker.

// `status` is the exit code of `n8n-chamber.sh status`: 0 = clean, 1 = something is there, 2 = could not tell.
// Starting a chamber replaces any existing one, and with it any unsaved edits, so a start must refuse when
// something is there. When we cannot tell, the start goes ahead and reports its own problem.
export function startVerdict(status) {
  if (status === 1) {
    return {
      refuse: true,
      message: "A chamber is already running (or was left behind by a crash), so a new one was not started.\n" +
        "  To save its edits and remove it:  node harness/n8n-dev.mjs ui-stop\n" +
        "  To just remove it:                bash ./scripts/n8n-chamber.sh down",
    };
  }
  return { refuse: false };
}

// Did a stop that began at `began` (milliseconds) save anything? The export folder keeps the previous session's
// files, so only files written during this stop count. `files` is a list of { mtimeMs }.
export function savedSince(files, began, slackMs = 2000) {
  return files.some((f) => f.mtimeMs >= began - slackMs);
}

// ---------- what is left from an earlier session, and what to offer ----------
const HOUR_MS = 60 * 60 * 1000;
export const STALE_MS = 24 * HOUR_MS;

// How long ago, in words a person would use.
export function agePhrase(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "a while ago";
  if (ms < 2 * 60_000) return "just now";
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)} minutes ago`;
  if (ms < 24 * HOUR_MS) { const h = Math.round(ms / HOUR_MS); return `about ${h} hour${h === 1 ? "" : "s"} ago`; }
  if (ms < 48 * HOUR_MS) return "yesterday";
  return `${Math.floor(ms / (24 * HOUR_MS))} days ago`;
}

// Edits saved at `savedAt` are used up once a change was applied at or after that time. `pull` and the session report both use
// this, so they can never disagree about whether something is still waiting.
export const editsConsumed = (savedAt, appliedAt) => savedAt !== null && savedAt !== undefined && appliedAt !== null && appliedAt !== undefined && appliedAt >= savedAt;

// Works out what an earlier session left behind. Nothing here touches Docker or the disk.
//   editor    "running" | "stopped" | "none" | "unknown" (Docker is not running)
//   manifest  what `ui` recorded for the session ({ workflowDir, createdAt }), or null
//   savedAt   when the editor's contents were last saved to disk (ms), or null
//   appliedAt when a change was last applied to the workflow (ms), or null
//   drift     true if the workflow changed since the session began, null if not known
//   changes   how many changes the saved edits hold, or null
//   now       the current time in ms
// Kinds: none | unknown | editor-running | editor-stopped | editor-orphan | saved-edits
export function describeSession({ editor, manifest, savedAt, appliedAt, drift, changes, now }) {
  const base = { workflow: manifest?.workflowDir ?? null, drift: drift ?? null, changes: changes ?? null };
  if (editor === "running" || editor === "stopped") {
    const since = manifest ? Date.parse(manifest.createdAt) : NaN;
    if (!manifest) return { kind: "editor-orphan", ...base, ageMs: null, stale: false };
    const ageMs = Number.isFinite(since) ? now - since : null;
    return { kind: editor === "running" ? "editor-running" : "editor-stopped", ...base, ageMs, stale: ageMs !== null && ageMs > STALE_MS };
  }
  const pending = manifest && savedAt !== null && (changes ?? 0) > 0 && !editsConsumed(savedAt, appliedAt);
  if (pending) {
    const ageMs = now - savedAt;
    return { kind: "saved-edits", ...base, ageMs, stale: ageMs > STALE_MS };
  }
  return { kind: editor === "unknown" ? "unknown" : "none", ...base, ageMs: null, stale: false };
}

// Starting a new editor replaces whatever is left, and with it any edits in it or saved from it. So it must refuse.
export const startGuard = (kind) => ({ refuse: ["editor-running", "editor-stopped", "editor-orphan", "saved-edits"].includes(kind) });

// Why a start was refused, if it was: a still-running or leftover editor (the Docker check said so, or the session
// does), or edits saved from the last editor that were never applied. Returns null when the start may go ahead.
export function startRefusal({ verdict, session }) {
  if (!verdict.refuse && !startGuard(session.kind).refuse) return null;
  if (session.kind === "saved-edits") {
    return {
      state: "pending-edits",
      message: "Edits saved from the last editor were never applied, and a new editor would delete them.\n" +
        `  To look at them:     node harness/n8n-dev.mjs pull ${session.workflow ?? "<workflow-dir>"}\n` +
        "  To throw them away:  node harness/n8n-dev.mjs ui-discard",
    };
  }
  return {
    state: "already-running",
    message: verdict.message ?? "An editor from earlier is still there.\n  To save its edits and remove it:  node harness/n8n-dev.mjs ui-stop\n  To throw it away:                  node harness/n8n-dev.mjs ui-discard",
  };
}
