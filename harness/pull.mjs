// Planning for `n8n-dev pull`: read the chamber session, compute what the person changed, and describe it.
// File access is injected (readJson / exists) so this can be unit tested without a disk or Docker.
import { createHash } from "node:crypto";
import { computePatch, combinePatches, applyPatch } from "./merge.mjs";

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
