#!/usr/bin/env node
// Prints the workflow folders CI should test for a pull request, one per line:
//   - every workflow folder with a changed file, plus
//   - every workflow that calls a changed workflow (Execute Workflow node), repeated until nothing new is added.
// If shared parts change (harness/, config/, scripts/, CI files, package files), every workflow is tested.
// Usage: node harness/changed.mjs <base-git-ref>     e.g. origin/main
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const base = process.argv[2] || "origin/main";
const config = JSON.parse(fs.readFileSync("config/readiness.json", "utf8"));
const root = (config.workflowsDir || "workflows").replace(/\/+$/, "");
const all = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `${root}/${d.name}`);
const changedFiles = execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" }).split("\n").filter(Boolean);

const shared = /^(harness\/|config\/|scripts\/|\.github\/|package(-lock)?\.json$)/;
if (changedFiles.some((f) => shared.test(f))) { console.log(all.join("\n")); process.exit(0); }

const selected = new Set(all.filter((dir) => changedFiles.some((f) => f.startsWith(dir + "/"))));

// Map workflow id -> folder, and folder -> ids of workflows it calls.
const idOf = {}, calls = {};
for (const dir of all) {
  const file = path.join(dir, "workflow.json");
  if (!fs.existsSync(file)) continue;
  const wf = JSON.parse(fs.readFileSync(file, "utf8"));
  idOf[wf.id] = dir;
  calls[dir] = wf.nodes
    .filter((n) => n.type === "n8n-nodes-base.executeWorkflow")
    .map((n) => (typeof n.parameters?.workflowId === "object" ? n.parameters.workflowId.value : n.parameters?.workflowId))
    .filter(Boolean);
}
let grew = true;
while (grew) {
  grew = false;
  for (const dir of all) {
    if (selected.has(dir)) continue;
    if ((calls[dir] || []).some((id) => selected.has(idOf[id]))) { selected.add(dir); grew = true; }
  }
}
console.log([...selected].join("\n"));
