// Pull-back merge: turns edits made in the sealed chamber into changes to the real workflow.json.
//
// Three workflows are involved:
//   base    the faked copy the harness loaded into the chamber (outside steps and the trigger are Code nodes)
//   edited  that copy exported after a person changed it in the editor
//   real    workflow.json in the repo
//
// Only what the person CHANGED (base -> edited) is applied to real. Simulated nodes (the fake trigger and the
// fake outside steps) are never copied back: they are stand-ins, not your workflow. Everything here is pure
// (no files, no Docker) so it can be unit tested. Node identity is the node id, which n8n keeps on export.

// Nodes the harness adds to the faked copy; they never belong in the real workflow.
export const isHarnessNode = (n) => n.id === "test-start" || String(n.id).startsWith("ui-note-");

// Fields that are cosmetic or per-copy, never pulled.
const IGNORED_FIELDS = new Set(["id", "position"]);

// Canonical form: sorted keys, and empty objects / undefined dropped. n8n sometimes adds or drops an empty
// `options: {}` when it saves, which is not a real change.
export function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const c = canon(v[k]);
      if (c === undefined) continue;
      if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return v;
}
const text = (x) => {
  const c = canon(x);
  if (c === undefined) return "";
  if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 0) return "";
  return JSON.stringify(c);
};
export const same = (a, b) => text(a) === text(b);

// Connections are keyed by node NAME in the file; edges are compared by node ID so a rename is not a rewire.
export function edgesOf(wf) {
  const idOf = new Map(wf.nodes.map((n) => [n.name, n.id]));
  const out = [];
  for (const [fromName, byType] of Object.entries(wf.connections || {})) {
    for (const [type, outputs] of Object.entries(byType)) {
      (outputs || []).forEach((list, o) => (list || []).forEach((e) => {
        out.push({ from: idOf.get(fromName), type, out: o, to: idOf.get(e.node), in: e.index ?? 0 });
      }));
    }
  }
  return out.filter((e) => e.from !== undefined && e.to !== undefined);
}
export const edgeKey = (e) => `${e.from}|${e.type}|${e.out}|${e.to}|${e.in}`;

// What did the person change in the chamber copy?
//   simulatedIds   ids of nodes that are stand-ins in the faked copy (the trigger and the outside steps)
//   warnForNew     optional: returns warning strings for a node that was added in the editor
// Returns { ops, skipped, warnings }. `skipped` are changes deliberately NOT applied, each with a reason.
export function computePatch({ base, edited, simulatedIds, warnForNew = () => [] }) {
  const ops = [], skipped = [], warnings = [];
  const index = (wf) => new Map(wf.nodes.filter((n) => !isHarnessNode(n)).map((n) => [n.id, n]));
  const b = index(base), e = index(edited);
  const gone = new Set();   // simulated nodes the person deleted from the copy

  for (const [id, bn] of b) {
    const en = e.get(id);
    if (!en) {
      if (simulatedIds.has(id)) {
        skipped.push({ kind: "simulated-removed", id, name: bn.name,
          detail: `"${bn.name}" is a simulated step and was deleted in the editor. Not removed from workflow.json; remove it there by hand if you meant to.` });
        gone.add(id);
      } else {
        ops.push({ op: "removeNode", id, name: bn.name });
      }
      continue;
    }
    const changed = [...new Set([...Object.keys(bn), ...Object.keys(en)])]
      .filter((f) => !IGNORED_FIELDS.has(f) && !same(bn[f], en[f]));
    if (!changed.length) continue;
    if (simulatedIds.has(id)) {
      skipped.push({ kind: "simulated-edited", id, name: bn.name, fields: changed,
        detail: `"${bn.name}" is simulated by the test. Change its fake data in the test's YAML mocks instead.` });
      continue;
    }
    for (const f of changed) {
      if (f === "credentials") {
        skipped.push({ kind: "credentials", id, name: bn.name,
          detail: `"${bn.name}": credentials set in the chamber are not real and were not applied.` });
        continue;
      }
      ops.push({ op: "set", id, name: bn.name, field: f, value: en[f] });
      if (f === "name") warnings.push(`Renamed "${bn.name}" to "${en.name}". Tests refer to nodes by name, so update them if needed.`);
    }
  }
  for (const [id, en] of e) {
    if (b.has(id)) continue;
    ops.push({ op: "addNode", node: en });
    warnings.push(...warnForNew(en));
  }

  const harness = new Set([...base.nodes, ...edited.nodes].filter(isHarnessNode).map((n) => n.id));
  const keep = (x) => ![x.from, x.to].some((id) => harness.has(id) || gone.has(id));
  const be = new Map(edgesOf(base).filter(keep).map((x) => [edgeKey(x), x]));
  const ee = new Map(edgesOf(edited).filter(keep).map((x) => [edgeKey(x), x]));
  for (const [k, x] of be) if (!ee.has(k)) ops.push({ op: "removeEdge", edge: x });
  for (const [k, x] of ee) if (!be.has(k)) ops.push({ op: "addEdge", edge: x });
  return { ops, skipped, warnings };
}

const opKey = (o) =>
  o.op === "set" ? `set:${o.id}:${o.field}`
  : o.op === "addNode" ? `add:${o.node.id}`
  : o.op === "removeNode" ? `rm:${o.id}`
  : o.op === "addEdge" ? `e+:${edgeKey(o.edge)}`
  : `e-:${edgeKey(o.edge)}`;

// Several test copies can be edited in one session. Their patches combine if they agree; if two copies changed the
// same thing differently, or one deleted a node another edited, that is a conflict and nothing should be applied.
export function combinePatches(patches) {
  const byKey = new Map(), conflicts = [];
  for (const o of patches.flatMap((p) => p.ops)) {
    const k = opKey(o), prev = byKey.get(k);
    if (!prev) byKey.set(k, o);
    else if (!same(prev, o)) conflicts.push({ key: k, detail: `Two edited copies disagree about ${k}.` });
  }
  const all = [...byKey.values()];
  for (const r of all.filter((o) => o.op === "removeNode")) {
    if (all.some((o) => o.op === "set" && o.id === r.id)) {
      conflicts.push({ key: `rm:${r.id}`, detail: `"${r.name}" was deleted in one copy and edited in another.` });
    }
  }
  const dedupe = (xs) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
  return {
    ops: all,
    conflicts,
    skipped: dedupe(patches.flatMap((p) => p.skipped)),
    warnings: [...new Set(patches.flatMap((p) => p.warnings))],
  };
}

// Applies ops to a copy of the real workflow. Never mutates its input.
export function applyPatch(real, ops) {
  const out = JSON.parse(JSON.stringify(real));
  const warnings = [];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let edges = edgesOf(out);

  for (const o of ops) {
    if (o.op === "removeNode") out.nodes = out.nodes.filter((n) => n.id !== o.id);
    else if (o.op === "addNode") out.nodes.push(clone(o.node));
    else if (o.op === "set") {
      const n = out.nodes.find((x) => x.id === o.id);
      if (!n) { warnings.push(`Could not change "${o.name}": it is no longer in workflow.json.`); continue; }
      if (o.value === undefined) delete n[o.field]; else n[o.field] = clone(o.value);
    }
  }

  const alive = new Set(out.nodes.map((n) => n.id));
  const removed = new Set(ops.filter((o) => o.op === "removeEdge").map((o) => edgeKey(o.edge)));
  edges = edges.filter((x) => !removed.has(edgeKey(x)));
  for (const o of ops.filter((x) => x.op === "addEdge")) {
    if (!alive.has(o.edge.from) || !alive.has(o.edge.to)) { warnings.push("Skipped a new connection to a node that is not in workflow.json."); continue; }
    if (!edges.some((x) => edgeKey(x) === edgeKey(o.edge))) edges.push({ ...o.edge });
  }
  edges = edges.filter((x) => alive.has(x.from) && alive.has(x.to));

  const names = new Map(out.nodes.map((n) => [n.id, n.name]));
  const conns = {};
  for (const x of edges) {
    const arr = (((conns[names.get(x.from)] ??= {})[x.type]) ??= []);
    while (arr.length <= x.out) arr.push([]);
    arr[x.out].push({ node: names.get(x.to), type: x.type, index: x.in });
  }
  out.connections = conns;
  return { merged: out, warnings };
}
