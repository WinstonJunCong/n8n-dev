// Unit tests for harness/pull.mjs. Run with: npm test   (no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan, describeOps, hashOf } from "./pull.mjs";

// ---------- fixtures: a real workflow, two faked copies, and an in-memory "disk" ----------
const node = (id, name, type, extra = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters: {}, ...extra });
const conns = (pairs) => {
  const c = {};
  for (const [from, to] of pairs) (((c[from] ??= {}).main) ??= [[]])[0].push({ node: to, type: "main", index: 0 });
  return c;
};
const real = () => ({
  name: "Demo",
  nodes: [node("t", "Trigger", "n8n-nodes-base.webhook"), node("i", "Check", "n8n-nodes-base.if", { parameters: { v: 1 } }), node("s", "Compose", "n8n-nodes-base.set", { parameters: { text: "a" } })],
  connections: conns([["Trigger", "Check"], ["Check", "Compose"]]),
});
const copy = (id) => ({
  name: `[test] ${id}`,
  nodes: [node("t", "Trigger", "n8n-nodes-base.code"), ...real().nodes.slice(1), node("test-start", "__test_start__", "n8n-nodes-base.manualTrigger")],
  connections: conns([["__test_start__", "Trigger"], ["Trigger", "Check"], ["Check", "Compose"]]),
});
const manifestFor = (r) => ({
  workflowFile: "w/workflow.json", realHash: hashOf(r), variantsDir: "v", exportDir: "x",
  variants: [{ id: "c1", test: "first" }, { id: "c2", test: "second" }],
});
const session = ({ r = real(), edits = {}, skipExport = [] } = {}) => {
  const files = { "w/workflow.json": r, "v/c1.json": copy("c1"), "v/c2.json": copy("c2"), "x/c1.json": copy("c1"), "x/c2.json": copy("c2") };
  for (const id of skipExport) delete files[`x/${id}.json`];
  for (const [file, fn] of Object.entries(edits)) fn(files[file]);
  return {
    manifest: manifestFor(real()),
    readJson: (p) => JSON.parse(JSON.stringify(files[p])),
    exists: (p) => p in files,
    isSimulated: (n) => n.type.endsWith("webhook"),
  };
};
const byId = (wf, id) => wf.nodes.find((n) => n.id === id);

// ---------- tests ----------
test("an untouched session has nothing to pull", () => {
  const plan = buildPlan(session());
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.drift, false);
  assert.deepEqual(describeOps(plan), []);
});

test("an edit in one copy is described and applied to the merged workflow", () => {
  const plan = buildPlan(session({ edits: { "x/c1.json": (w) => { byId(w, "s").parameters = { text: "b" }; } } }));
  assert.deepEqual(describeOps(plan), ['Changed parameters of "Compose"']);
  assert.deepEqual(byId(plan.merged, "s").parameters, { text: "b" });
  assert.deepEqual(byId(plan.real, "s").parameters, { text: "a" });   // the real workflow object is untouched
});

test("drift is detected when workflow.json changed after the chamber opened", () => {
  const changed = real();
  byId(changed, "s").parameters = { text: "edited by someone else" };
  const plan = buildPlan(session({ r: changed }));
  assert.equal(plan.drift, true);
});

test("a copy the chamber did not save is reported, the others are still used", () => {
  const plan = buildPlan(session({ skipExport: ["c2"], edits: { "x/c1.json": (w) => { byId(w, "s").parameters = { text: "b" }; } } }));
  assert.deepEqual(plan.missing, ["second"]);
  assert.equal(plan.ops.length, 1);
});

test("no saved copies at all is an error", () => {
  const plan = buildPlan(session({ skipExport: ["c1", "c2"] }));
  assert.match(plan.error, /nothing to pull/);
});

test("copies that disagree surface a conflict", () => {
  const plan = buildPlan(session({ edits: {
    "x/c1.json": (w) => { byId(w, "s").parameters = { text: "one" }; },
    "x/c2.json": (w) => { byId(w, "s").parameters = { text: "two" }; },
  } }));
  assert.equal(plan.conflicts.length, 1);
});

test("editing the simulated trigger is reported as not applied", () => {
  const plan = buildPlan(session({ edits: { "x/c1.json": (w) => { byId(w, "t").parameters = { jsCode: "return []" }; } } }));
  assert.deepEqual(plan.ops, []);
  assert.equal(plan.skipped[0].kind, "simulated-edited");
});

test("new nodes are reported through warnForNew", () => {
  const plan = buildPlan({
    ...session({ edits: { "x/c1.json": (w) => { w.nodes.push(node("n9", "Call out", "n8n-nodes-base.httpRequest")); } } }),
    warnForNew: (n) => [`new ${n.name}`],
  });
  assert.deepEqual(plan.warnings, ["new Call out"]);
});

test("describeOps words each kind of change", () => {
  const plan = buildPlan(session({ edits: { "x/c1.json": (w) => {
    byId(w, "s").name = "Build text";
    w.nodes.push(node("n1", "Notify", "n8n-nodes-base.set"));
    w.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Check"], ["Check", "Build text"], ["Build text", "Notify"]]);
    w.nodes = w.nodes.filter((n) => n.id !== "i");
  } } }));
  const text = describeOps(plan);
  assert.ok(text.includes('Renamed "Compose" to "Build text"'));
  assert.ok(text.includes('Added "Notify" (n8n-nodes-base.set)'));
  assert.ok(text.includes('Removed "Check"'));
  assert.ok(text.some((t) => t.startsWith("Connected ")));
  assert.ok(text.some((t) => t.startsWith("Disconnected ")));
});
