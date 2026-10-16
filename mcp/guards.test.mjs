// Unit tests for mcp/guards.mjs. Run with: npm test   (no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import { isValidWorkflowName, resolveWorkflow, pickPort, truncate, hashOf, makeRateLimiter, makeCodeStore, strictArgs } from "./guards.mjs";

// ---------- workflow names ----------
test("ordinary workflow names are accepted", () => {
  for (const n of ["site-health-alert", "store_pickup_reminder", "A1", "a", "x".repeat(64)]) assert.ok(isValidWorkflowName(n), n);
});

test("names that could point outside the workflows folder are rejected", () => {
  const attacks = ["..", ".", "../etc", "a/b", "a\\b", "/abs", "C:\\x", "a b", "a\nb", "a\0b", "", "-lead", "_lead",
    "x".repeat(65), "..%2f", "a;rm", "a$(x)", "caf\u00e9", "\u202e", " a", "a "];
  for (const n of attacks) assert.ok(!isValidWorkflowName(n), JSON.stringify(n));
});

test("names that are not strings are rejected", () => {
  for (const n of [undefined, null, 1, {}, [], ["a"], true]) assert.ok(!isValidWorkflowName(n), String(n));
});

test("resolveWorkflow returns the folder for a real workflow", () => {
  const seen = [];
  const r = resolveWorkflow({ name: "site-health-alert", exists: (p) => (seen.push(p), true) });
  assert.deepEqual(r, { dir: "workflows/site-health-alert" });
  assert.deepEqual(seen, ["workflows/site-health-alert/workflow.json"]);
});

test("resolveWorkflow honours a different workflows folder", () => {
  assert.deepEqual(resolveWorkflow({ workflowsDir: "flows/", name: "x", exists: () => true }), { dir: "flows/x" });
});

test("resolveWorkflow refuses a missing workflow and never asks the disk about a bad name", () => {
  assert.match(resolveWorkflow({ name: "nope", exists: () => false }).error, /no workflow called "nope"/);
  let asked = false;
  const r = resolveWorkflow({ name: "../secrets", exists: () => { asked = true; return true; } });
  assert.ok(r.error);
  assert.equal(asked, false);
});

// ---------- ports ----------
test("pickPort accepts the default and sensible ports", () => {
  assert.deepEqual(pickPort(undefined), { port: 5678 });
  assert.deepEqual(pickPort(null), { port: 5678 });
  assert.deepEqual(pickPort(8080), { port: 8080 });
  assert.deepEqual(pickPort("8080"), { port: 8080 });
  assert.deepEqual(pickPort(1024), { port: 1024 });
  assert.deepEqual(pickPort(65535), { port: 65535 });
});

test("pickPort rejects anything else", () => {
  for (const p of [80, 1023, 65536, -1, 0, 1.5, "80; rm", "abc", "", "5678 ", NaN, Infinity, {}, [], true]) {
    assert.ok(pickPort(p).error, JSON.stringify(p));
  }
});

// ---------- truncate / hash ----------
test("truncate leaves short text alone and keeps both ends of long text", () => {
  assert.equal(truncate("short", 100), "short");
  const out = truncate("A".repeat(50) + "B".repeat(50), 40);
  assert.ok(out.startsWith("A"));
  assert.ok(out.endsWith("B"));
  assert.match(out, /60 characters left out/);
  assert.equal(truncate(undefined), "");
});

test("hashOf is stable and sensitive to content", () => {
  assert.equal(hashOf({ a: 1 }), hashOf({ a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.equal(hashOf("x"), hashOf("x"));
  assert.match(hashOf("x"), /^[0-9a-f]{64}$/);
});

// ---------- rate limiter ----------
test("the rate limiter allows `max` uses per window, then says when to retry", () => {
  let t = 1000;
  const lim = makeRateLimiter({ max: 3, windowMs: 3600_000, now: () => t });
  assert.ok(lim.take().ok);
  t += 10; assert.ok(lim.take().ok);
  t += 10; assert.ok(lim.take().ok);
  t += 10;
  const blocked = lim.take();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryInMs, 3600_000 - 30);
  t += 3600_000;                                   // the first use has now left the window
  assert.ok(lim.take().ok);
});

test("a blocked attempt does not count as a use", () => {
  let t = 0;
  const lim = makeRateLimiter({ max: 1, windowMs: 100, now: () => t });
  assert.ok(lim.take().ok);
  for (let i = 0; i < 20; i++) { t += 1; assert.equal(lim.take().ok, false); }
  t = 101;
  assert.ok(lim.take().ok);
});

// ---------- one-time codes ----------
const codes = (opts = {}) => {
  let t = 0, n = 111111;
  return { store: makeCodeStore({ now: () => t, random: () => n++, ...opts }), tick: (ms) => { t += ms; } };
};

test("a code works once for the thing it was issued for", () => {
  const { store } = codes();
  const code = store.issue("wf:abc");
  assert.ok(store.redeem(code, "wf:abc").ok);
  assert.equal(store.redeem(code, "wf:abc").ok, false);   // already used
});

test("a code does not work for different content", () => {
  const { store } = codes();
  const code = store.issue("wf:abc");
  const r = store.redeem(code, "wf:CHANGED");
  assert.equal(r.ok, false);
  assert.match(r.reason, /different preview|content changed/);
});

test("a code expires", () => {
  const { store, tick } = codes({ ttlMs: 1000 });
  const code = store.issue("s");
  tick(1001);
  assert.match(store.redeem(code, "s").reason, /expired/);
  assert.equal(store.redeem(code, "s").ok, false);
});

test("a code is dropped after too many wrong tries, even if the right subject follows", () => {
  const { store } = codes({ maxTries: 3 });
  const code = store.issue("good");
  for (let i = 0; i < 3; i++) assert.equal(store.redeem(code, "bad").ok, false);
  assert.equal(store.redeem(code, "good").ok, false);
});

test("an unknown or malformed code is refused", () => {
  const { store } = codes();
  store.issue("s");
  for (const c of ["000000", "", undefined, null, "abc", 42]) assert.equal(store.redeem(c, "s").ok, false, String(c));
});

test("a new preview for the same subject replaces the old code", () => {
  const { store } = codes();
  const first = store.issue("s");
  const second = store.issue("s");
  assert.notEqual(first, second);
  assert.equal(store.redeem(first, "s").ok, false);
  assert.ok(store.redeem(second, "s").ok);
});

test("codes for different subjects are independent", () => {
  const { store } = codes();
  const a = store.issue("a"), b = store.issue("b");
  assert.ok(store.redeem(a, "a").ok);
  assert.ok(store.redeem(b, "b").ok);
});

// ---------- strictArgs ----------

test("strictArgs accepts exactly the allowed keys and returns only those", () => {
  assert.deepEqual(strictArgs({ workflow: "a" }, { workflow: { type: "string", required: true } }), { value: { workflow: "a" } });
  assert.deepEqual(strictArgs({}, { port: { type: "any" } }), { value: {} });
  assert.deepEqual(strictArgs(undefined, {}), { value: {} });
  assert.deepEqual(strictArgs(null, {}), { value: {} });
  assert.deepEqual(strictArgs({ port: 8080 }, { port: { type: "any" } }), { value: { port: 8080 } });
});

test("strictArgs rejects unknown keys, including prototype tricks", () => {
  const spec = { workflow: { type: "string", required: true } };
  for (const bad of [{ workflow: "a", extra: 1 }, { workflow: "a", __proto__x: 1 }, { workflow: "a", constructor: 1 }, { workflow: "a", toString: 1 }]) {
    assert.ok(strictArgs(bad, spec).error, JSON.stringify(bad));
  }
  assert.ok(strictArgs(JSON.parse('{"workflow":"a","__proto__":{"x":1}}'), spec).error);
});

test("strictArgs rejects missing required values, wrong types, and arguments that are not an object", () => {
  const spec = { workflow: { type: "string", required: true } };
  assert.match(strictArgs({}, spec).error, /Missing required argument "workflow"/);
  assert.match(strictArgs({ workflow: null }, spec).error, /Missing required/);
  for (const v of [1, true, ["a"], { a: 1 }]) assert.match(strictArgs({ workflow: v }, spec).error, /must be text/, JSON.stringify(v));
  for (const bad of ["text", 5, true, ["a"]]) assert.match(strictArgs(bad, spec).error, /must be an object/, JSON.stringify(bad));
});
