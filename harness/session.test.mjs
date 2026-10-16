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
});
