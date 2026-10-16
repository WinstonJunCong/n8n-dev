// Unit tests for harness/merge.mjs. Run with: npm test   (uses Node's built-in test runner; no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import { computePatch, combinePatches, applyPatch, canon, same, edgesOf, isHarnessNode } from "./merge.mjs";

// ---------- fixtures ----------
const node = (id, name, type, extra = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters: {}, ...extra });
const conns = (pairs) => {
  const c = {};
  for (const [from, to, out = 0] of pairs) {
    const arr = (((c[from] ??= {}).main) ??= []);
    while (arr.length <= out) arr.push([]);
    arr[out].push({ node: to, type: "main", index: 0 });
  }
  return c;
};

// The real workflow: webhook -> HTTP call -> IF -> Set. The webhook and the HTTP call are the outside steps.
const real = () => ({
  name: "Demo",
  nodes: [
    node("t", "Trigger", "n8n-nodes-base.webhook"),
    node("h", "Call API", "n8n-nodes-base.httpRequest", { parameters: { url: "={{ $json.url }}" }, credentials: { httpHeaderAuth: { id: "cred1", name: "Real credential" } } }),
    node("i", "Is bad?", "n8n-nodes-base.if", { parameters: { value: "ok" } }),
    node("s", "Compose", "n8n-nodes-base.set", { parameters: { text: "alert" } }),
  ],
  connections: conns([["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Compose"]]),
});
const SIMULATED = new Set(["t", "h"]);

// The faked copy the chamber loads: simulated nodes are Code nodes, plus harness nodes.
const base = () => {
  const r = real();
  return {
    name: "[test] Demo",
    nodes: [
      node("t", "Trigger", "n8n-nodes-base.code", { parameters: { jsCode: "return [{json:{}}]" } }),
      node("h", "Call API", "n8n-nodes-base.code", { parameters: { jsCode: "return [{json:{status:'down'}}]" } }),
      r.nodes[2], r.nodes[3],
      node("test-start", "__test_start__", "n8n-nodes-base.manualTrigger"),
      node("ui-note-1", "Note: test input", "n8n-nodes-base.stickyNote"),
    ],
    connections: conns([["__test_start__", "Trigger"], ["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Compose"]]),
  };
};
const patch = (edited, extra = {}) => computePatch({ base: base(), edited, simulatedIds: SIMULATED, ...extra });
const byId = (wf, id) => wf.nodes.find((n) => n.id === id);

// ---------- helpers ----------
test("canon ignores key order and empty objects", () => {
  assert.deepEqual(canon({ b: 1, a: { x: {} } }), { b: 1 });
  assert.ok(same({ a: 1, options: {} }, { options: undefined, a: 1 }));
  assert.ok(!same({ a: 1 }, { a: 2 }));
});

test("edges are compared by node id, so a rename is not a rewire", () => {
  const w = real();
  const before = edgesOf(w).map((e) => `${e.from}>${e.to}`);
  byId(w, "s").name = "Build text";
  w.connections = conns([["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Build text"]]);
  assert.deepEqual(edgesOf(w).map((e) => `${e.from}>${e.to}`), before);
});

test("harness nodes are recognised", () => {
  assert.ok(isHarnessNode({ id: "test-start" }));
  assert.ok(isHarnessNode({ id: "ui-note-3" }));
  assert.ok(!isHarnessNode({ id: "i" }));
});

// ---------- nothing changed ----------
test("no edits means no changes", () => {
  const p = patch(base());
  assert.deepEqual(p, { ops: [], skipped: [], warnings: [] });
});

test("moving nodes or changing harness notes is not a change", () => {
  const e = base();
  byId(e, "i").position = [500, 500];
  byId(e, "ui-note-1").parameters = { content: "edited note" };
  e.nodes = e.nodes.filter((n) => n.id !== "test-start");
  e.connections = conns([["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Compose"]]);
  assert.deepEqual(patch(e).ops, []);
});

test("n8n re-saving an untouched node with an empty options object is not a change", () => {
  const e = base();
  byId(e, "i").parameters = { value: "ok", options: {} };
  assert.deepEqual(patch(e).ops, []);
});

test("n8n adding an empty default string inside an IF node is not a change (seen on a real export)", () => {
  const e = base();
  byId(e, "i").parameters = { value: "ok", conditions: { options: { caseSensitive: true, leftValue: "", version: 2 } } };
  const b = base();
  byId(b, "i").parameters = { value: "ok", conditions: { options: { caseSensitive: true, version: 2 } } };
  const p = computePatch({ base: b, edited: e, simulatedIds: SIMULATED });
  assert.deepEqual(p.ops, []);
});

test("changing a value to an empty string on purpose IS a change", () => {
  const e = base();
  byId(e, "s").parameters = { text: "" };
  const p = patch(e);
  assert.equal(p.ops.length, 1);
  assert.equal(p.ops[0].op, "set");
});

// ---------- editing real nodes ----------
test("editing a real node is applied and leaves the rest untouched", () => {
  const e = base();
  byId(e, "i").parameters = { value: "fine" };
  const p = patch(e);
  assert.deepEqual(p.ops, [{ op: "set", id: "i", name: "Is bad?", field: "parameters", value: { value: "fine" } }]);
  const { merged } = applyPatch(real(), p.ops);
  assert.deepEqual(byId(merged, "i").parameters, { value: "fine" });
  assert.deepEqual(byId(merged, "h").credentials, real().nodes[1].credentials);
  assert.equal(byId(merged, "h").type, "n8n-nodes-base.httpRequest");
  assert.deepEqual(merged.connections, real().connections);
});

test("applyPatch does not mutate its input", () => {
  const r = real();
  const snapshot = JSON.stringify(r);
  applyPatch(r, [{ op: "removeNode", id: "s", name: "Compose" }]);
  assert.equal(JSON.stringify(r), snapshot);
});

test("a removed field is removed", () => {
  const e = base();
  const r = real();
  r.nodes[3].notes = "x";
  const b = base();
  b.nodes[3].notes = "x";
  delete byId(e, "s").notes;
  const p = computePatch({ base: b, edited: e, simulatedIds: SIMULATED });
  const { merged } = applyPatch(r, p.ops);
  assert.ok(!("notes" in byId(merged, "s")));
});

// ---------- simulated nodes ----------
test("editing a simulated node is skipped, never copied to the real node", () => {
  const e = base();
  byId(e, "h").parameters = { jsCode: "return [{json:{status:'ok'}}]" };
  const p = patch(e);
  assert.deepEqual(p.ops, []);
  assert.equal(p.skipped.length, 1);
  assert.equal(p.skipped[0].kind, "simulated-edited");
  assert.match(p.skipped[0].detail, /YAML mocks/);
  const { merged } = applyPatch(real(), p.ops);
  assert.equal(byId(merged, "h").type, "n8n-nodes-base.httpRequest");
});

test("deleting a simulated node is skipped, and its connections are left alone", () => {
  const e = base();
  e.nodes = e.nodes.filter((n) => n.id !== "h");
  e.connections = conns([["__test_start__", "Trigger"], ["Is bad?", "Compose"]]);
  const p = patch(e);
  assert.equal(p.skipped[0].kind, "simulated-removed");
  assert.deepEqual(p.ops, []);
  const { merged } = applyPatch(real(), p.ops);
  assert.deepEqual(merged.connections, real().connections);
});

// ---------- credentials ----------
test("credentials set in the chamber are never applied", () => {
  const e = base();
  byId(e, "i").credentials = { someApi: { id: "chamber-only", name: "x" } };
  const p = patch(e);
  assert.deepEqual(p.ops, []);
  assert.equal(p.skipped[0].kind, "credentials");
});

// ---------- adding, removing, rewiring ----------
test("removing a real node removes it and its connections", () => {
  const e = base();
  e.nodes = e.nodes.filter((n) => n.id !== "s");
  e.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Call API"], ["Call API", "Is bad?"]]);
  const p = patch(e);
  assert.ok(p.ops.some((o) => o.op === "removeNode" && o.id === "s"));
  const { merged } = applyPatch(real(), p.ops);
  assert.ok(!byId(merged, "s"));
  assert.ok(!("Is bad?" in merged.connections));
  assert.deepEqual(merged.connections["Call API"].main[0], [{ node: "Is bad?", type: "main", index: 0 }]);
});

test("adding a node and a connection is applied", () => {
  const e = base();
  e.nodes.push(node("n1", "Notify", "n8n-nodes-base.set", { parameters: { text: "hi" }, position: [900, 0] }));
  e.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Compose"], ["Compose", "Notify"]]);
  const p = patch(e);
  assert.ok(p.ops.some((o) => o.op === "addNode" && o.node.id === "n1"));
  const { merged, warnings } = applyPatch(real(), p.ops);
  assert.deepEqual(warnings, []);
  assert.deepEqual(byId(merged, "n1").position, [900, 0]);
  assert.deepEqual(merged.connections["Compose"].main[0], [{ node: "Notify", type: "main", index: 0 }]);
});

test("a new node is reported through warnForNew", () => {
  const e = base();
  e.nodes.push(node("n2", "Extra call", "n8n-nodes-base.httpRequest"));
  const p = patch(e, { warnForNew: (n) => (n.type.endsWith("httpRequest") ? [`New outside step "${n.name}"`] : []) });
  assert.deepEqual(p.warnings, ['New outside step "Extra call"']);
});

test("rewiring the false branch of an IF keeps output positions", () => {
  const r = real();
  r.nodes.push(node("z", "Ignore", "n8n-nodes-base.set"));
  r.connections = conns([["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Compose", 0], ["Is bad?", "Ignore", 1]]);
  const b = base();
  b.nodes.push(r.nodes[4]);
  b.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Compose", 0], ["Is bad?", "Ignore", 1]]);
  const e = JSON.parse(JSON.stringify(b));
  e.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Compose", 1], ["Is bad?", "Ignore", 0]]);
  const p = computePatch({ base: b, edited: e, simulatedIds: SIMULATED });
  const { merged } = applyPatch(r, p.ops);
  assert.equal(merged.connections["Is bad?"].main[0][0].node, "Ignore");
  assert.equal(merged.connections["Is bad?"].main[1][0].node, "Compose");
});

test("a rename updates the connections and warns", () => {
  const e = base();
  byId(e, "s").name = "Build text";
  e.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Call API"], ["Call API", "Is bad?"], ["Is bad?", "Build text"]]);
  const p = patch(e);
  assert.deepEqual(p.ops.map((o) => o.op), ["set"]);
  assert.match(p.warnings[0], /Renamed "Compose" to "Build text"/);
  const { merged } = applyPatch(real(), p.ops);
  assert.equal(byId(merged, "s").name, "Build text");
  assert.equal(merged.connections["Is bad?"].main[0][0].node, "Build text");
});

// ---------- combining copies ----------
test("copies that make the same edit combine into one", () => {
  const e = base();
  byId(e, "i").parameters = { value: "fine" };
  const out = combinePatches([patch(e), patch(e)]);
  assert.equal(out.ops.length, 1);
  assert.deepEqual(out.conflicts, []);
});

test("copies that edit different nodes combine", () => {
  const e1 = base(), e2 = base();
  byId(e1, "i").parameters = { value: "fine" };
  byId(e2, "s").parameters = { text: "new text" };
  const out = combinePatches([patch(e1), patch(e2)]);
  assert.equal(out.ops.length, 2);
  assert.deepEqual(out.conflicts, []);
});

test("copies that edit the same field differently conflict", () => {
  const e1 = base(), e2 = base();
  byId(e1, "i").parameters = { value: "one" };
  byId(e2, "i").parameters = { value: "two" };
  const out = combinePatches([patch(e1), patch(e2)]);
  assert.equal(out.conflicts.length, 1);
});

test("deleting a node in one copy and editing it in another conflicts", () => {
  const e1 = base(), e2 = base();
  e1.nodes = e1.nodes.filter((n) => n.id !== "s");
  e1.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Call API"], ["Call API", "Is bad?"]]);
  byId(e2, "s").parameters = { text: "changed" };
  const out = combinePatches([patch(e1), patch(e2)]);
  assert.ok(out.conflicts.some((c) => c.key === "rm:s"));
});
