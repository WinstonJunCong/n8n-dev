// Planning for `n8n-dev pull`: read the chamber session, compute what the person changed, and describe it.
// File access is injected (readJson / exists) so this can be unit tested without a disk or Docker.
import { createHash } from "node:crypto";
import { computePatch, combinePatches, applyPatch, same } from "./merge.mjs";

// Same hash `ui` records in the manifest, so `pull` can tell if workflow.json changed while the chamber was open.
export const hashOf = (wf) => createHash("sha256").update(JSON.stringify(wf)).digest("hex");

// manifest     what `ui` wrote: workflowFile, realHash, variantsDir, exportDir, variants[{id, test}]
// isSimulated  (node) => true for the trigger and outside steps of the REAL workflow
// warnForNew   (node) => warning strings for a node added in the editor
export function buildPlan({ manifest, readJson, exists, isSimulated, warnForNew = () => [] }) {
  const real = readJson(manifest.workflowFile);
  const drift = hashOf(real) !== manifest.realHash;
  const simulatedIds = new Set(real.nodes.filter(isSimulated).map((n) => n.id));
  const patches = [], missing = [];
  for (const v of manifest.variants) {
    const exported = `${manifest.exportDir}/${v.id}.json`;
    if (!exists(exported)) { missing.push(v.test); continue; }
    patches.push(computePatch({
      base: readJson(`${manifest.variantsDir}/${v.id}.json`), edited: readJson(exported), simulatedIds, warnForNew,
    }));
  }
  if (!patches.length) return { error: "The chamber saved no workflows, so there is nothing to pull. Did it close cleanly?" };
  const combined = combinePatches(patches);
  const { merged, warnings: applyWarnings } = applyPatch(real, combined.ops);
  return {
    real, merged, drift, missing,
    ops: combined.ops, conflicts: combined.conflicts, skipped: combined.skipped,
    warnings: [...combined.warnings, ...applyWarnings],
  };
}

// One plain sentence per change, for the person reading the dry run.
export function describeOps(plan) {
  const nameOf = (id) => (plan.merged.nodes.find((n) => n.id === id) || plan.real.nodes.find((n) => n.id === id) || { name: id }).name;
  return plan.ops.map((o) => {
    if (o.op === "set") return o.field === "name" ? `Renamed "${o.name}" to "${o.value}"` : `Changed ${o.field} of "${o.name}"`;
    if (o.op === "addNode") return `Added "${o.node.name}" (${o.node.type})`;
    if (o.op === "removeNode") return `Removed "${o.name}"`;
    if (o.op === "addEdge") return `Connected "${nameOf(o.edge.from)}" to "${nameOf(o.edge.to)}"`;
    return `Disconnected "${nameOf(o.edge.from)}" from "${nameOf(o.edge.to)}"`;
  });
}

// ---------- plain details of what changed ----------
// These feed `--json` output, so an assistant can show a person exactly what changed without reading any file.

export const humanize = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Every leaf value that differs between two JSON values, with its path. An empty string and a missing value count
// as the same thing (see merge.mjs), so n8n's empty defaults are not reported.
export function leafDiffs(before, after, pathSoFar = []) {
  if (isObj(before) && isObj(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((k) => leafDiffs(before[k], after[k], [...pathSoFar, k]));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return Array.from({ length: Math.max(before.length, after.length) }, (_, i) => leafDiffs(before[i], after[i], [...pathSoFar, i])).flat();
  }
  return same(before, after) ? [] : [{ path: pathSoFar, from: before, to: after }];
}

// A short name a person would recognise for the thing at `path`. A Set-node value is named after the field it sets
// ("text"), anything else after its last key in plain words ("right value").
export function labelFor(path, ...roots) {
  const last = path[path.length - 1];
  if (last === "value") {
    for (const root of roots) {
      const parent = path.slice(0, -1).reduce((o, k) => o?.[k], root);
      if (parent && typeof parent.name === "string") return parent.name;
    }
  }
  let i = path.length - 1;
  while (i > 0 && typeof path[i] === "number") i--;
  return humanize(path[i] ?? "setting");
}

// How a value reads to a person: n8n's leading "=" (it marks an expression) is dropped, long values are cut.
export function display(value, max = 160) {
  if (value === undefined || value === null || value === "") return "(nothing)";
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof value === "string" && s.startsWith("=")) s = s.slice(1);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// The plan as plain facts: nothing here mentions a command, a path or a file name of ours.
export function planToJson(plan) {
  const nameOf = (id) => (plan.merged.nodes.find((n) => n.id === id) || plan.real.nodes.find((n) => n.id === id) || { name: id }).name;
  const changes = plan.ops.map((o) => {
    if (o.op === "set" && o.field === "name") return { kind: "renamed", node: o.name, to: o.value };
    if (o.op === "set") {
      const before = plan.real.nodes.find((n) => n.id === o.id)?.[o.field];
      const b = { [o.field]: before }, a = { [o.field]: o.value };
      const details = leafDiffs(b, a).map((d) => ({ label: labelFor(d.path, a, b), from: display(d.from), to: display(d.to) }));
      return { kind: "changed", node: o.name, details };
    }
    if (o.op === "addNode") return { kind: "added", node: o.node.name, type: o.node.type };
    if (o.op === "removeNode") return { kind: "removed", node: o.name };
    if (o.op === "addEdge") return { kind: "connected", from: nameOf(o.edge.from), to: nameOf(o.edge.to) };
    return { kind: "disconnected", from: nameOf(o.edge.from), to: nameOf(o.edge.to) };
  });
  return {
    changes,
    notApplied: plan.skipped.map((s) => ({ node: s.name, reason: s.kind })),
    notes: plan.warnings,
    missing: plan.missing,
    conflicts: plan.conflicts.map((c) => c.detail),
    changedMeanwhile: plan.drift,
  };
}

// One decision for both the text and the JSON versions of `pull`, so they cannot disagree.
//   findings  readiness-scan findings for the merged result
// Returns { state } where state is one of: blocked (with reason), nothing, ready, apply.
export function decidePull({ plan, apply = false, force = false, findings = [] }) {
  if (plan.conflicts.length) return { state: "blocked", reason: "conflict" };
  if (!plan.ops.length) return { state: "nothing" };
  if (plan.drift && !force) return { state: "blocked", reason: "changed-meanwhile" };
  if (findings.length) return { state: "blocked", reason: "scan", findings };
  return { state: apply ? "apply" : "ready" };
}
