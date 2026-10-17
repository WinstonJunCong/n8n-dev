// Unit tests for harness/pull.mjs. Run with: npm test   (no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan, describeOps, hashOf, humanize, leafDiffs, labelFor, display, planToJson, decidePull } from "./pull.mjs";

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

// ---------- plain details of what changed ----------
test("humanize turns keys into everyday words", () => {
  assert.equal(humanize("rightValue"), "right value");
  assert.equal(humanize("jsCode"), "js code");
  assert.equal(humanize("typeVersion"), "type version");
  assert.equal(humanize("some_key-name"), "some key name");
});

test("leafDiffs finds exactly the values that changed, with their paths", () => {
  const d = leafDiffs({ a: 1, b: { c: "x", d: [1, 2] } }, { a: 1, b: { c: "y", d: [1, 3] } });
  assert.deepEqual(d, [{ path: ["b", "c"], from: "x", to: "y" }, { path: ["b", "d", 1], from: 2, to: 3 }]);
});

test("leafDiffs reports added and removed values, and ignores n8n's empty defaults", () => {
  assert.deepEqual(leafDiffs({ a: 1 }, { a: 1, b: "new" }), [{ path: ["b"], from: undefined, to: "new" }]);
  assert.deepEqual(leafDiffs({ a: 1, b: "old" }, { a: 1 }), [{ path: ["b"], from: "old", to: undefined }]);
  assert.deepEqual(leafDiffs({ a: 1 }, { a: 1, options: {}, note: "" }), []);
  assert.deepEqual(leafDiffs([1, 2], [1, 2, 3]), [{ path: [2], from: undefined, to: 3 }]);
  assert.deepEqual(leafDiffs("same", "same"), []);
});

test("labelFor names a Set value after the field it sets, and anything else in plain words", () => {
  const set = { assignments: { assignments: [{ id: "a1", name: "text", value: "=x" }] } };
  assert.equal(labelFor(["assignments", "assignments", 0, "value"], set), "text");
  assert.equal(labelFor(["conditions", "conditions", 0, "rightValue"], {}), "right value");
  assert.equal(labelFor(["parameters", "jsCode"], {}), "js code");
  assert.equal(labelFor(["notes"], {}), "notes");
  assert.equal(labelFor([], {}), "setting");
});

test("display reads like text a person would write", () => {
  assert.equal(display("=ALERT: {{ $json.site }} is down"), "ALERT: {{ $json.site }} is down");
  assert.equal(display(undefined), "(nothing)");
  assert.equal(display(""), "(nothing)");
  assert.equal(display(5), "5");
  assert.equal(display({ a: 1 }), '{"a":1}');
  assert.equal(display("x".repeat(300)).length, 161);
  assert.ok(display("x".repeat(300)).endsWith("…"));
});

// A real-shaped fixture: a Set node whose message text is an n8n expression, like the site-health-alert sample.
const setSession = (editFn, extra = {}) => {
  const r = real();
  byId(r, "s").parameters = { assignments: { assignments: [{ id: "a1", name: "text", value: "=ALERT: down", type: "string" }] } };
  const c = (id) => { const w = copy(id); byId(w, "s").parameters = JSON.parse(JSON.stringify(byId(r, "s").parameters)); return w; };
  const files = { "w/workflow.json": r, "v/c1.json": c("c1"), "v/c2.json": c("c2"), "x/c1.json": c("c1"), "x/c2.json": c("c2") };
  editFn(files);
  return {
    manifest: { ...manifestFor(r), ...extra },
    readJson: (p) => JSON.parse(JSON.stringify(files[p])),
    exists: (p) => p in files,
    isSimulated: (n) => n.type.endsWith("webhook"),
  };
};

test("planToJson shows what a person changed: the node, what it is called, and the old and new text", () => {
  const plan = buildPlan(setSession((f) => { f["x/c1.json"].nodes.find((n) => n.id === "s").parameters.assignments.assignments[0].value = "=TEST: down"; }));
  assert.deepEqual(planToJson(plan).changes, [
    { kind: "changed", node: "Compose", details: [{ label: "text", from: "ALERT: down", to: "TEST: down" }] },
  ]);
});

test("planToJson words every other kind of change", () => {
  const plan = buildPlan(session({ edits: { "x/c1.json": (w) => {
    byId(w, "s").name = "Build text";
    w.nodes.push(node("n1", "Notify", "n8n-nodes-base.set"));
    w.connections = conns([["__test_start__", "Trigger"], ["Trigger", "Check"], ["Check", "Build text"], ["Build text", "Notify"]]);
    w.nodes = w.nodes.filter((n) => n.id !== "i");
  } } }));
  const kinds = planToJson(plan).changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["added", "connected", "disconnected", "disconnected", "removed", "renamed"]);
  const renamed = planToJson(plan).changes.find((c) => c.kind === "renamed");
  assert.deepEqual(renamed, { kind: "renamed", node: "Compose", to: "Build text" });
  const added = planToJson(plan).changes.find((c) => c.kind === "added");
  assert.deepEqual(added, { kind: "added", node: "Notify", type: "n8n-nodes-base.set" });
});

test("planToJson lists what was not applied and why, plus notes, missing copies, conflicts and drift", () => {
  const plan = buildPlan({
    ...session({ skipExport: ["c2"], edits: { "x/c1.json": (w) => { byId(w, "t").parameters = { jsCode: "return []" }; } } }),
    warnForNew: () => [],
  });
  const j = planToJson(plan);
  assert.deepEqual(j.notApplied, [{ node: "Trigger", reason: "simulated-edited" }]);
  assert.deepEqual(j.missing, ["second"]);
  assert.deepEqual(j.changes, []);
  assert.equal(j.changedMeanwhile, false);
  const changed = real();
  byId(changed, "s").parameters = { text: "someone else" };
  assert.equal(planToJson(buildPlan(session({ r: changed }))).changedMeanwhile, true);
  const conflict = planToJson(buildPlan(session({ edits: {
    "x/c1.json": (w) => { byId(w, "s").parameters = { text: "one" }; },
    "x/c2.json": (w) => { byId(w, "s").parameters = { text: "two" }; },
  } })));
  assert.equal(conflict.conflicts.length, 1);
});

test("planToJson survives being turned into text and back, so it is safe to print as JSON", () => {
  const plan = buildPlan(setSession((f) => { f["x/c1.json"].nodes.find((n) => n.id === "s").parameters.assignments.assignments[0].value = "=TEST"; }));
  const j = planToJson(plan);
  assert.deepEqual(JSON.parse(JSON.stringify(j)), j);
});

// ---------- the shared decision ----------
const plan = (over = {}) => ({ conflicts: [], ops: [{ op: "set" }], drift: false, ...over });

test("decidePull: conflicts block everything, even when there is nothing else to do", () => {
  assert.deepEqual(decidePull({ plan: plan({ conflicts: [{}], ops: [] }) }), { state: "blocked", reason: "conflict" });
});

test("decidePull: nothing to apply is not an error, and not blocked by drift", () => {
  assert.deepEqual(decidePull({ plan: plan({ ops: [], drift: true }) }), { state: "nothing" });
});

test("decidePull: a changed workflow file blocks unless forced", () => {
  assert.deepEqual(decidePull({ plan: plan({ drift: true }) }), { state: "blocked", reason: "changed-meanwhile" });
  assert.equal(decidePull({ plan: plan({ drift: true }), force: true }).state, "ready");
});

test("decidePull: readiness findings block, even when forced or applying", () => {
  const findings = [{ node: "x", message: "a key" }];
  assert.deepEqual(decidePull({ plan: plan(), findings }), { state: "blocked", reason: "scan", findings });
  assert.equal(decidePull({ plan: plan(), findings, apply: true, force: true }).state, "blocked");
});

test("decidePull: ready is a preview, apply only when asked", () => {
  assert.deepEqual(decidePull({ plan: plan() }), { state: "ready" });
  assert.deepEqual(decidePull({ plan: plan(), apply: true }), { state: "apply" });
});
