// Unit tests for harness/session.mjs. Run with: npm test   (no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import { startVerdict, savedSince } from "./session.mjs";

// ---------- starting a chamber ----------
test("a start is refused when a chamber is already there, with both ways out in the message", () => {
  const v = startVerdict(1);
  assert.equal(v.refuse, true);
  assert.match(v.message, /already running/);
  assert.match(v.message, /ui-stop/);                    // save the edits and remove it
  assert.match(v.message, /n8n-chamber\.sh down/);       // just remove it
});

test("a start goes ahead when nothing is there", () => {
  assert.deepEqual(startVerdict(0), { refuse: false });
});

test("a start goes ahead when the state cannot be told, so the start reports its own problem", () => {
  for (const status of [2, null, undefined, 127, -1]) assert.equal(startVerdict(status).refuse, false, String(status));
});

// ---------- did the stop save anything? ----------
test("files from an earlier session do not count as saved", () => {
  assert.equal(savedSince([{ mtimeMs: 1000 }, { mtimeMs: 2000 }], 100_000), false);
});

test("files written during the stop count as saved", () => {
  assert.equal(savedSince([{ mtimeMs: 1000 }, { mtimeMs: 100_500 }], 100_000), true);
});

test("an empty export folder is not a save", () => {
  assert.equal(savedSince([], 100_000), false);
});

test("the slack allows for clocks that differ by a moment, but no more", () => {
  assert.equal(savedSince([{ mtimeMs: 98_000 }], 100_000), true);    // exactly 2 s before: counts
  assert.equal(savedSince([{ mtimeMs: 97_999 }], 100_000), false);   // just outside: does not
  assert.equal(savedSince([{ mtimeMs: 97_999 }], 100_000, 5000), true);
});

test("one fresh file among old ones is enough", () => {
  const old = Array.from({ length: 10 }, (_, i) => ({ mtimeMs: i }));
  assert.equal(savedSince([...old, { mtimeMs: 100_001 }], 100_000), true);
});

// ---------- wiring ----------
test("the command line really uses these functions instead of carrying its own copies of the logic", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "n8n-dev.mjs"), "utf8");
  assert.match(source, /import\s*\{[^}]*startVerdict[^}]*\}\s*from\s*"\.\/session\.mjs"/);
  assert.match(source, /startVerdict\(\s*running\.status\s*\)/);
  assert.match(source, /savedSince\(\s*exported\s*,\s*began\s*\)/);
  // starting an editor must go through the refusal rule, so saved edits can never be wiped by a new one
  assert.match(source, /startRefusal\(\s*\{\s*verdict\s*,\s*session\s*\}\s*\)/);
  assert.match(source, /if\s*\(\s*refusal\s*\)\s*bail\(/);
  assert.match(source, /describeSession\(\s*\{/);
});

// ---------- what is left from an earlier session ----------
import { agePhrase, describeSession, startGuard, STALE_MS } from "./session.mjs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const MANIFEST = { workflowDir: "flows/demo", createdAt: "2026-10-19T09:00:00Z" };
const facts = (over) => describeSession({ editor: "none", manifest: MANIFEST, savedAt: null, appliedAt: null, drift: false, changes: 2, now: NOW, ...over });

test("ages are said the way a person would say them", () => {
  const min = 60_000, hour = 60 * min;
  assert.equal(agePhrase(30_000), "just now");
  assert.equal(agePhrase(5 * min), "5 minutes ago");
  assert.equal(agePhrase(59 * min), "59 minutes ago");
  assert.equal(agePhrase(hour), "about 1 hour ago");
  assert.equal(agePhrase(3 * hour), "about 3 hours ago");
  assert.equal(agePhrase(1.2 * hour + 2 * 60 * min), "about 3 hours ago");
  assert.equal(agePhrase(30 * hour), "yesterday");
  assert.equal(agePhrase(5 * 24 * hour), "5 days ago");
  for (const bad of [NaN, -1, undefined]) assert.equal(agePhrase(bad), "a while ago");
});

test("an editor that is still there is reported with its age, whether it is running or stopped", () => {
  const running = facts({ editor: "running" });
  assert.deepEqual([running.kind, running.ageMs, running.stale, running.workflow], ["editor-running", 3 * 3600_000, false, "flows/demo"]);
  assert.equal(facts({ editor: "stopped" }).kind, "editor-stopped");
  assert.equal(facts({ editor: "stopped", manifest: { ...MANIFEST, createdAt: "2026-10-17T09:00:00Z" } }).stale, true);
  assert.equal(facts({ editor: "running", manifest: null }).kind, "editor-orphan");
});

test("saved edits that were never applied are found; applied, empty or missing ones are not", () => {
  const saved = NOW - 2 * 3600_000;
  const pending = facts({ savedAt: saved });
  assert.deepEqual([pending.kind, pending.ageMs, pending.changes], ["saved-edits", 2 * 3600_000, 2]);
  assert.equal(facts({ savedAt: saved, appliedAt: saved + 1000 }).kind, "none", "applied after they were saved");
  assert.equal(facts({ savedAt: saved, appliedAt: saved - 1000 }).kind, "saved-edits", "applied before they were saved does not count");
  assert.equal(facts({ savedAt: saved, changes: 0 }).kind, "none", "nothing was changed in them");
  assert.equal(facts({ savedAt: null }).kind, "none");
  assert.equal(facts({ savedAt: saved, manifest: null }).kind, "none");
  assert.equal(facts({ savedAt: NOW - STALE_MS - 1 }).stale, true);
  assert.equal(facts({ savedAt: NOW - STALE_MS + 1000 }).stale, false);
});

test("drift is carried through, and a missing Docker still finds saved edits", () => {
  assert.equal(facts({ savedAt: NOW - 1000, drift: true }).drift, true);
  assert.equal(facts({ editor: "unknown", savedAt: NOW - 1000 }).kind, "saved-edits");
  assert.equal(facts({ editor: "unknown" }).kind, "unknown");
});

test("starting a new editor is refused for everything an earlier session can leave behind", () => {
  for (const kind of ["editor-running", "editor-stopped", "editor-orphan", "saved-edits"]) assert.equal(startGuard(kind).refuse, true, kind);
  for (const kind of ["none", "unknown"]) assert.equal(startGuard(kind).refuse, false, kind);
});

import { startRefusal } from "./session.mjs";

test("a start is refused with the right reason for each thing an earlier session can leave", () => {
  const ok = { refuse: false }, no = (message) => ({ refuse: true, message });
  assert.equal(startRefusal({ verdict: ok, session: facts({ editor: "none" }) }), null);
  assert.equal(startRefusal({ verdict: ok, session: facts({ editor: "unknown" }) }), null, "when Docker cannot be asked, the start reports its own problem");
  const saved = startRefusal({ verdict: ok, session: facts({ savedAt: NOW - 1000 }) });
  assert.equal(saved.state, "pending-edits");
  assert.match(saved.message, /pull flows\/demo/);
  assert.match(saved.message, /ui-discard/);
  const running = startRefusal({ verdict: no("A chamber is already running"), session: facts({ editor: "running" }) });
  assert.equal(running.state, "already-running");
  assert.match(running.message, /already running/);
  assert.equal(startRefusal({ verdict: ok, session: facts({ editor: "stopped" }) }).state, "already-running", "a stopped editor still holds edits");
  assert.equal(startRefusal({ verdict: no("x"), session: facts({ savedAt: NOW - 1000 }) }).state, "pending-edits");
});

import { editsConsumed } from "./session.mjs";

test("edits are used up once a change was applied at or after they were saved, and not before", () => {
  assert.equal(editsConsumed(1000, 1000), true, "applied at the same moment");
  assert.equal(editsConsumed(1000, 5000), true);
  assert.equal(editsConsumed(5000, 1000), false, "applied before they were saved");
  for (const [saved, applied] of [[null, 5], [1000, null], [null, null], [undefined, 5], [5, undefined]]) assert.equal(editsConsumed(saved, applied), false, `${saved}, ${applied}`);
});
