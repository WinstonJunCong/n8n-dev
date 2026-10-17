#!/usr/bin/env node
// n8n-dev: proof-of-concept test harness for governed n8n development.
//   n8n-dev scan      <workflow-dir> [--workflow-file f.json]   readiness scan (no live IDs, keys, hosts)
//   n8n-dev structure <workflow-dir> [--workflow-file f.json]   valid nodes, versions, connections
//   n8n-dev test      <workflow-dir> [--workflow-file f.json]   run YAML tests with every outside step faked
//   n8n-dev check     <workflow-dir> [--workflow-file f.json]   all three + markdown/JSON report (what CI runs)
//   n8n-dev ui        <workflow-dir> [--port 5678]              the faked tests in a sealed local n8n editor (needs Docker)
//   n8n-dev ui        <workflow-dir> --detach                   same, but returns at once and leaves it running (no terminal needed)
//   n8n-dev ui-stop                                             save the edits from a detached chamber and remove it
//   n8n-dev tests-fix <workflow-dir> [--apply] [--from-report f]  update tests that fail only because they expect the wording just changed (dry run unless --apply)
//   n8n-dev undo                                                put back workflow.json as it was before the last pull --apply (only if untouched since)
//   n8n-dev status                                              is a sealed editor still open? (0 clean, 1 something is there, 2 unknown)
//   --json (on check, pull, undo, ui --detach, ui-stop)               print the facts as one JSON object, for programs such as the MCP server
//   n8n-dev pull      [<workflow-dir>] [--apply] [--force]      bring edits saved in that editor back into workflow.json (dry run unless --apply)
// The n8n CLI is taken from $N8N_CMD (default "n8n"). Each run uses a fresh, throwaway n8n data folder,
// so nothing touches a real n8n, real credentials or real services.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, parseDocument } from "yaml";
import { buildPlan, describeOps, planToJson, decidePull } from "./pull.mjs";
import { startVerdict, savedSince } from "./session.mjs";
import { findBash } from "./shell.mjs";
import { makeRecord, addTestEdits, decideUndo, safeRelative } from "./backup.mjs";
import { planTestUpdates, rewriteTestText } from "./testfix.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/readiness.json"), "utf8"));
const N8N_CMD = process.env.N8N_CMD || "n8n";
const N8N_VERSION = process.env.N8N_VERSION || CONFIG.n8nVersion || "2.43.4";
const WORK = path.join(ROOT, ".n8n-dev");
const UNDO_FILE = path.join(WORK, "last-apply.json");
const TRIGGER_RE = /(Trigger|webhook)$/i;

// ---------- helpers ----------
const args = process.argv.slice(2);
const cmd = args[0];
const wfDir = args[1] && path.resolve(args[1]);
const flag = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };
const wfFile = flag("--workflow-file") ? path.resolve(flag("--workflow-file")) : wfDir && path.join(wfDir, "workflow.json");

// Paths handed to n8n are relative to the repo root (forward slashes), and n8n runs with the repo root
// as its working folder. This keeps them valid on Windows, macOS, Linux and inside the Docker container.
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
// On Windows, run N8N_CMD and the chamber through Git Bash so the .sh scripts work (cmd.exe cannot run them). Git Bash
// is found by where Git is installed, never by the plain name `bash`, which on Windows is WSL's Linux shell
// (see shell.mjs). Only the commands that really need bash stop when it cannot be found.
const gitPaths = process.platform === "win32"
  ? (spawnSync("where", ["git"], { encoding: "utf8" }).stdout || "").split(/\r?\n/).filter(Boolean) : [];
const BASH = findBash({ platform: process.platform, env: process.env, exists: fs.existsSync, gitPaths });
if (BASH.error && (/\.sh$/.test(N8N_CMD) || ["ui", "ui-stop", "status"].includes(cmd))) { console.error(BASH.error); process.exit(2); }
const SHELL = BASH.shell ?? true;
function n8n(sub, dataDir) {
  const r = spawnSync(`${N8N_CMD} ${sub}`, {
    shell: SHELL, cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, N8N_VERSION, N8N_USER_FOLDER: rel(dataDir), N8N_DIAGNOSTICS_ENABLED: "false",
           N8N_RUNNERS_ENABLED: "true", MSYS_NO_PATHCONV: "1" },
  });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
}
const freshDir = (name) => { const d = path.join(WORK, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const isOutside = (n) => !!n.credentials || CONFIG.outsideNodeTypes.includes(n.type);
const isTrigger = (n) => TRIGGER_RE.test(n.type.split(".").pop());
const getPath = (obj, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function walkStrings(value, visit, where = "") {
  if (typeof value === "string") visit(value, where);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, `${where}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walkStrings(v, visit, where ? `${where}.${k}` : k);
}

// ---------- 1. readiness scan ----------
function scan(wf) {
  const findings = [];
  const hint = CONFIG.configHint || "your config";
  const rules = (CONFIG.secretRules || []).map((r) => ({ id: r.id, re: new RegExp(r.pattern), msg: r.message.replaceAll("{configHint}", hint) }));
  for (const n of wf.nodes) {
    walkStrings(n.parameters, (s, where) => {
      for (const r of rules) if (r.re.test(s)) findings.push({ node: n.name, where, rule: r.id, message: r.msg });
      for (const m of s.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
        const host = m[1].toLowerCase();
        if (CONFIG.liveN8nHosts.includes(host)) findings.push({ node: n.name, where, rule: "live-n8n", message: `Calls the live n8n (${host}); a copy would trigger live workflows` });
        else if (!CONFIG.allowedHosts.includes(host)) findings.push({ node: n.name, where, rule: "host", message: `Address typed into the node (${host}); not on the allowed list, read it from ${hint}` });
      }
    });
  }
  return findings;
}

// ---------- 2. structure check ----------
function structure(wf) {
  const problems = [];
  const cache = path.join(WORK, `nodes-${N8N_VERSION}.json`); // cached between runs (CI caches it too)
  if (!fs.existsSync(cache)) {
    const d = freshDir("nodes-export");
    const r = n8n(`export:nodes --output=${JSON.stringify(rel(cache))}`, d);
    if (!r.ok || !fs.existsSync(cache)) return [{ node: "-", message: "Could not list n8n node types: " + r.err.slice(-300) }];
  }
  const known = {};
  for (const t of JSON.parse(fs.readFileSync(cache, "utf8"))) known[t.name] = [...(known[t.name] || []), ...[].concat(t.version)];
  const names = new Set();
  for (const n of wf.nodes) {
    if (names.has(n.name)) problems.push({ node: n.name, message: "Duplicate node name" });
    names.add(n.name);
    if (!known[n.type]) problems.push({ node: n.name, message: `Unknown node type ${n.type}` });
    else if (!known[n.type].includes(n.typeVersion)) problems.push({ node: n.name, message: `Version ${n.typeVersion} of ${n.type} not available in this n8n` });
  }
  for (const [from, c] of Object.entries(wf.connections || {})) {
    if (!names.has(from)) problems.push({ node: from, message: "Connection from a node that does not exist" });
    for (const out of c.main || []) for (const e of out || []) if (!names.has(e.node)) problems.push({ node: from, message: `Connects to missing node "${e.node}"` });
  }
  const triggers = wf.nodes.filter(isTrigger);
  if (triggers.length !== 1) problems.push({ node: "-", message: `Expected exactly 1 trigger, found ${triggers.length}` });
  return problems;
}

// ---------- 3. tests ----------
function buildVariant(wf, test, id) {
  const v = JSON.parse(JSON.stringify(wf));
  v.id = id; v.name = `[test] ${test.test}`; v.active = false; v.pinData = {};
  const mocks = test.mocks || {};
  for (const name of Object.keys(mocks)) if (!v.nodes.some((n) => n.name === name)) throw new Error(`Mock for unknown node "${name}"`);
  const trigger = v.nodes.find(isTrigger);
  v.nodes = v.nodes.map((n) => {
    const code = (js) => ({ id: n.id, name: n.name, type: "n8n-nodes-base.code", typeVersion: 2, position: n.position, parameters: { jsCode: js } });
    if (n === trigger) {
      const payload = n.type.endsWith(".webhook") ? { headers: {}, params: {}, query: {}, body: test.trigger || {} } : test.trigger || {};
      return code(`return [{ json: ${JSON.stringify(payload)} }];`);
    }
    if (isOutside(n)) {
      if (mocks[n.name]) return code(`return ${JSON.stringify(mocks[n.name].map((j) => ({ json: j })))};`);
      return code(`throw new Error(${JSON.stringify(`Unmocked outside step "${n.name}" was reached. Tests never call real services: add a mock for it.`)});`);
    }
    return n;
  });
  v.nodes.push({ id: "test-start", name: "__test_start__", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [-240, 0], parameters: {} });
  v.connections.__test_start__ = { main: [[{ node: trigger.name, type: "main", index: 0 }]] };
  return v;
}

function inputItems(runData, name) {
  const run = runData[name]?.[0];
  const src = run?.source?.[0];
  if (!src) return run ? [{}] : [];
  return runData[src.previousNode]?.[src.previousNodeRun || 0]?.data?.main?.[src.previousNodeOutput || 0] || [];
}
const outputItems = (runData, name) => runData[name]?.[0]?.data?.main?.flat().filter(Boolean) || [];
const parseVal = (s) => { try { return JSON.parse(s); } catch { return s.trim(); } };

function evaluate(assertion, runData, wf) {
  let m;
  if ((m = assertion.match(/^node "(.+)" called (\d+) times?$/))) {
    const got = runData[m[1]] ? inputItems(runData, m[1]).length : 0;
    return { pass: got === Number(m[2]), detail: `called ${got} time(s)` };
  }
  if ((m = assertion.match(/^node "(.+)" not called$/))) {
    return { pass: !runData[m[1]], detail: runData[m[1]] ? "it was called" : "not called" };
  }
  if ((m = assertion.match(/^node "(.+)" (input|output)\.(\S+) (==|!=|contains) (.+)$/))) {
    const [, node, side, p, op, raw] = m;
    if (!runData[node]) return { pass: false, detail: "node was never reached" };
    const item = (side === "input" ? inputItems(runData, node) : outputItems(runData, node))[0]?.json;
    const got = getPath(item, p), want = parseVal(raw);
    const pass = op === "contains" ? String(got ?? "").includes(String(want))
      : op === "==" ? String(got) === String(want) : String(got) !== String(want);
    return { pass, detail: `${side}.${p} = ${JSON.stringify(got)}` };
  }
  if ((m = assertion.match(/^workflow ends at "(.+)"$/))) {
    const next = (wf.connections[m[1]]?.main || []).flat().map((e) => e.node);
    const ranNext = next.filter((n) => runData[n]);
    const pass = !!runData[m[1]] && ranNext.length === 0;
    return { pass, detail: !runData[m[1]] ? "never reached" : ranNext.length ? `continued to ${ranNext.join(", ")}` : "ended there" };
  }
  return { pass: false, detail: "Unrecognised assertion syntax" };
}

function runTests(wf) {
  const testDir = path.join(wfDir, "tests");
  const files = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (!files.length) return [{ file: "-", name: "No tests found", pass: false, error: "Add tests under tests/*.yaml", checks: [] }];
  const dataDir = freshDir("n8n-data");
  const varDir = freshDir("variants");
  const plans = files.map((f, i) => {
    const test = parseYaml(fs.readFileSync(path.join(testDir, f), "utf8"));
    const id = `test${String(i + 1).padStart(2, "0")}${Date.now().toString(36)}`.slice(0, 16);
    try {
      fs.writeFileSync(path.join(varDir, `${id}.json`), JSON.stringify(buildVariant(wf, test, id)));
      return { f, test, id };
    } catch (e) { return { f, test, id, buildError: e.message }; }
  });
  const imp = n8n(`import:workflow --separate --input=${JSON.stringify(rel(varDir))}`, dataDir);
  if (!imp.ok) return plans.map((p) => ({ file: p.f, name: p.test.test, pass: false, error: "Import failed: " + imp.err.slice(-400), checks: [] }));
  // Fast path: run every test in ONE n8n start (execute-batch). A passing run leaves a snapshot file
  // with the full execution data. Tests without a snapshot (failed runs) are re-run one by one to get the error.
  const snapDir = freshDir("snapshots");
  const ids = plans.filter((p) => !p.buildError).map((p) => p.id);
  const batchStart = Date.now();
  if (ids.length) n8n(`execute-batch --ids=${ids.join(",")} --snapshot=${JSON.stringify(rel(snapDir))} --retries=0 --concurrency=4 --shortOutput`, dataDir);
  const batchSeconds = ((Date.now() - batchStart) / 1000 / Math.max(ids.length, 1)).toFixed(1);
  return plans.map(({ f, test, id, buildError }) => {
    if (buildError) return { file: f, name: test.test, pass: false, error: buildError, checks: [] };
    let exec, seconds = batchSeconds, raw = "";
    const snap = path.join(snapDir, `${id}-snapshot.json`);
    if (fs.existsSync(snap)) exec = JSON.parse(fs.readFileSync(snap, "utf8"));
    else {
      const started = Date.now();
      const r = n8n(`execute --id=${id} --rawOutput`, dataDir);
      raw = r.err || r.out;
      try { const a = r.out.search(/^\{/m), b = r.out.lastIndexOf("\n}"); exec = JSON.parse(r.out.slice(a, b + 2)); } catch { /* handled below */ }
      seconds = ((Date.now() - started) / 1000).toFixed(1);
    }
    const runData = exec?.data?.resultData?.runData || {};
    const execError = exec?.data?.resultData?.error;
    const checks = (test.assert || []).map((a) => ({ assertion: a, ...evaluate(a, runData, wf) }));
    const error = !exec ? "n8n did not return a result: " + raw.slice(-400)
      : execError ? `Workflow failed at "${execError.node?.name || exec.data.resultData.lastNodeExecuted || "?"}": ${execError.message}` : null;
    return { file: f, name: test.test, pass: !error && checks.every((c) => c.pass), error, checks,
             path: Object.keys(runData).filter((n) => n !== "__test_start__"), seconds };
  });
}

// ---------- 4. ui: the faked tests in a sealed local n8n editor ----------
// Builds the same faked copies the tests use (outside steps = Code nodes, trigger = fake event) and loads them
// into the chamber (scripts/n8n-chamber.sh): an n8n editor with no route out, no repo mounted, and a throwaway
// database. Open one, click "Execute workflow", and watch each step's data. Ctrl+C removes everything.
// Colours the simulated parts so a person can tell fake from real at a glance. Sticky notes sit behind nodes and
// are never executed, so this only changes how the canvas looks (node names stay as they are; tests rely on them).
function decorateForUi(v, wf) {
  const SIMULATED = 7, LEGEND = 6;                 // n8n sticky-note colour indexes
  const trigger = wf.nodes.find(isTrigger);
  const simulated = wf.nodes.filter((n) => isTrigger(n) || isOutside(n)).map((n) => n.name);
  const pos = (name) => v.nodes.find((n) => n.name === name).position;
  const notes = [];
  const note = (name, x, y, width, height, content, color) =>
    notes.push({ id: `ui-note-${notes.length + 1}`, name, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position: [x, y], parameters: { content, width, height, color } });
  const [sx, sy] = pos("__test_start__"), [tx, ty] = pos(trigger.name);
  const left = Math.min(sx, tx) - 30;
  note("Note: test input", left, Math.min(sy, ty) - 70, Math.max(sx, tx) + 130 - left, 240, "### TEST INPUT\nThe fake event from the test file", SIMULATED);
  for (const name of simulated.filter((n) => n !== trigger.name)) {
    const [x, y] = pos(name);
    note(`Note: simulated ${name}`, x - 30, y - 70, 160, 240, "### SIMULATED\nFake reply from the test file", SIMULATED);
  }
  const top = Math.min(...v.nodes.map((n) => n.position[1])) - 70;
  note("Note: how to read this", Math.min(...v.nodes.map((n) => n.position[0])) - 30, top - 190, 560, 160,
    "### How to read this canvas\nThe **grey backdrops** are simulated by the test: the fake event and the fake replies from outside services.\nEverything **without** a backdrop is your real workflow logic, running for real.\nClick **Execute workflow** to run it.", LEGEND);
  v.nodes.push(...notes);
  return v;
}

function openUi(wf) {
  // `--detach --json` prints ONE JSON object describing what happened, and nothing else, for programs (the MCP server).
  const asJson = args.includes("--detach") && args.includes("--json");
  const bail = (code, state, message) => {
    if (asJson) console.log(JSON.stringify({ state, message }));
    else console.error(message);
    process.exit(code);
  };
  const testDir = path.join(wfDir, "tests");
  const files = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  if (!files.length) bail(1, "no-tests", "No tests found under " + testDir);
  const port = flag("--port") || "5678";
  if (!/^\d{2,5}$/.test(port)) bail(2, "bad-port", `--port must be a number, got "${port}"`);
  if (spawnSync("docker --version", { shell: SHELL, encoding: "utf8" }).status !== 0) {
    bail(1, "docker-missing", "ui needs Docker, because the sealed chamber runs in it. Install Docker Desktop and try again.");
  }
  // Starting a chamber replaces any existing one, and with it any unsaved edits. Refuse instead of doing that
  // silently. (Exit 1 = something is there; 2 = could not tell, which the start itself will report.)
  const running = spawnSync("bash ./scripts/n8n-chamber.sh status", { shell: SHELL, cwd: ROOT, encoding: "utf8" });
  const verdict = startVerdict(running.status);
  if (verdict.refuse) bail(1, "already-running", verdict.message);
  const varDir = freshDir("ui-variants");
  const exportDir = freshDir("ui-export");
  const slug = path.basename(wfDir).replace(/[^a-z0-9]/gi, "").slice(0, 8);
  const variants = [];
  try {
    files.forEach((f, i) => {
      const test = parseYaml(fs.readFileSync(path.join(testDir, f), "utf8"));
      const id = `ui${slug}${String(i + 1).padStart(2, "0")}`.slice(0, 16);
      fs.writeFileSync(path.join(varDir, `${id}.json`), JSON.stringify(decorateForUi(buildVariant(wf, test, id), wf)));
      variants.push({ id, test: test.test });
    });
  } catch (e) { bail(1, "build-failed", "Could not build the faked copies: " + e.message); }
  // Kept outside variantsDir on purpose: that folder is imported into n8n as-is. `pull` uses this to know which
  // workflow the copies came from and to notice if workflow.json changed while the chamber was open.
  fs.writeFileSync(path.join(WORK, "ui-manifest.json"), JSON.stringify({
    workflowDir: rel(wfDir), workflowFile: rel(wfFile), realHash: createHash("sha256").update(JSON.stringify(wf)).digest("hex"),
    variantsDir: rel(varDir), exportDir: rel(exportDir), variants, createdAt: new Date().toISOString(),
  }, null, 2));
  // --detach: bring the chamber up and return, for callers that cannot keep a terminal open (an assistant, a script).
  // It stays running until `ui-stop`, which saves any edits and removes it.
  if (args.includes("--detach")) {
    const started = spawnSync(`bash ./scripts/n8n-chamber.sh start ${JSON.stringify(rel(varDir))}`, {
      shell: SHELL, cwd: ROOT, stdio: asJson ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8",
      env: { ...process.env, N8N_VERSION, N8N_PORT: port, MSYS_NO_PATHCONV: "1" },
    });
    if (asJson) {
      const out = `${started.stdout || ""}${started.stderr || ""}`;
      const address = out.match(/READY (\S+)/)?.[1];
      const login = out.match(/sign in with:\s+(\S+)\s+\/\s+(\S+)/);
      const ok = started.status === 0 && address;
      console.log(JSON.stringify(ok
        ? { state: "started", address, login: login ? { email: login[1], password: login[2] } : null, workflow: rel(wfDir) }
        : { state: "failed", message: "The sealed editor did not start.", details: out.trim().slice(-400) }));
      process.exit(ok ? 0 : 1);
    }
    if (started.status === 0) console.log("\nThe chamber is running. To save any edits and close it:  node harness/n8n-dev.mjs ui-stop");
    process.exit(started.status ?? 1);
  }
  // Ctrl+C reaches this process as well as the chamber script. Ignore it here so the script can save and clean up,
  // and so this process is still alive to print the summary afterwards.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  spawnSync(`bash ./scripts/n8n-chamber.sh run ${JSON.stringify(rel(varDir))} ${JSON.stringify(rel(exportDir))}`, {
    shell: SHELL, cwd: ROOT, stdio: "inherit",
    env: { ...process.env, N8N_VERSION, N8N_PORT: port, MSYS_NO_PATHCONV: "1" },
  });
  printEditSummary();
  // Confirm nothing is left running. Exit code: 0 = clean, 1 = leftovers, 2 = could not check.
  const left = spawnSync("bash ./scripts/n8n-chamber.sh status", { shell: SHELL, cwd: ROOT, stdio: "inherit" });
  process.exit(left.status ?? 2);
}

// ---------- ui-stop: save the edits from a chamber started with `ui --detach`, then remove it ----------
function runUiStop() {
  const asJson = args.includes("--json");   // one JSON object and nothing else, for programs (the MCP server)
  const file = path.join(WORK, "ui-manifest.json");
  if (!fs.existsSync(file)) {
    if (asJson) console.log(JSON.stringify({ state: "no-session" }));
    else console.error("No chamber session found. Start one with `n8n-dev ui <workflow-dir> --detach`.");
    return 2;
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const began = Date.now();
  const stopped = spawnSync(`bash ./scripts/n8n-chamber.sh stop ${JSON.stringify(manifest.exportDir)}`, {
    shell: SHELL, cwd: ROOT, stdio: asJson ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8",
    env: { ...process.env, N8N_VERSION, MSYS_NO_PATHCONV: "1" },
  });
  // Only summarise if this stop actually saved something; otherwise the export folder holds an older session.
  const dir = path.resolve(ROOT, manifest.exportDir);
  const exported = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => ({ mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs })) : [];
  const saved = savedSince(exported, began);
  if (asJson) {
    let summary = null;
    if (saved) { try { const plan = loadPlan(); if (!plan.error) summary = { workflow: plan.manifest.workflowDir, ...planToJson(plan) }; } catch { /* reported as no summary */ } }
    console.log(JSON.stringify({ state: saved ? "saved" : "nothing-running", cleaned: stopped.status === 0, summary }));
    return stopped.status ?? 2;
  }
  if (saved) printEditSummary();
  else console.log("\nNo chamber was running, so nothing was saved.");
  return stopped.status ?? 2;
}

// ---------- 5. pull: bring edits made in the chamber back into workflow.json ----------
// Only changes to REAL nodes are applied (see merge.mjs). Dry run unless --apply. It refuses if the edited copies
// disagree, if workflow.json changed while the chamber was open, or if the result would fail the readiness scan.
function newNodeWarnings(n) {
  const out = [];
  if (isOutside(n)) out.push(`New outside step "${n.name}": add a mock for it in the tests, and read its address from ${CONFIG.configHint || "your config"} instead of typing it in.`);
  if (isTrigger(n)) out.push(`New trigger "${n.name}": a workflow must have exactly one trigger.`);
  return out;
}

function loadPlan() {
  const file = path.join(WORK, "ui-manifest.json");
  if (!fs.existsSync(file)) return { error: "No chamber session found. Run `n8n-dev ui <workflow-dir>` first." };
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const abs = (p) => path.resolve(ROOT, p);
  const plan = buildPlan({
    manifest,
    readJson: (p) => JSON.parse(fs.readFileSync(abs(p), "utf8")),
    exists: (p) => fs.existsSync(abs(p)),
    isSimulated: (n) => isTrigger(n) || isOutside(n),
    warnForNew: newNodeWarnings,
  });
  return { manifest, ...plan };
}

function printPlan(plan) {
  const lines = describeOps(plan);
  if (!lines.length && !plan.skipped.length && !plan.warnings.length) { console.log("No changes to pull: the edited copies match what was loaded."); return; }
  if (lines.length) { console.log("Changes you made to your workflow:"); lines.forEach((l) => console.log("  + " + l)); }
  else console.log("Nothing to apply to workflow.json.");
  if (plan.skipped.length) { console.log("Not applied:"); plan.skipped.forEach((s) => console.log("  - " + s.detail)); }
  if (plan.warnings.length) { console.log("Notes:"); plan.warnings.forEach((w) => console.log("  ! " + w)); }
  if (plan.missing.length) console.log(`The chamber did not save: ${plan.missing.join(", ")}`);
}

// What the person changed in the chamber, and how to bring it into workflow.json. Used when a chamber closes.
function printEditSummary() {
  try {
    const plan = loadPlan();
    if (plan.error) return;
    console.log();
    printPlan(plan);
    if (plan.ops.length) console.log(`\nTo bring this into ${plan.manifest.workflowFile}:  node harness/n8n-dev.mjs pull ${plan.manifest.workflowDir}`);
  } catch (e) { console.error("Could not summarise your edits: " + e.message); }
}

function runPull() {
  const asJson = args.includes("--json");   // one JSON object and nothing else, for programs (the MCP server)
  const out = (obj, code) => { console.log(JSON.stringify(obj)); return code; };
  const plan = loadPlan();
  if (plan.error) return asJson ? out({ state: "no-session" }, 2) : (console.error(plan.error), 2);
  const given = args[1] && !args[1].startsWith("--") ? rel(path.resolve(args[1])) : null;
  if (given && given !== plan.manifest.workflowDir) {
    if (asJson) return out({ state: "wrong-workflow", expected: plan.manifest.workflowDir, given }, 2);
    console.error(`The last chamber session was for ${plan.manifest.workflowDir}, not ${given}.`);
    return 2;
  }
  const findings = scan(plan.merged);
  const decision = decidePull({ plan, apply: args.includes("--apply"), force: args.includes("--force"), findings });
  const facts = { workflow: plan.manifest.workflowDir, ...planToJson(plan) };
  if (asJson && decision.state !== "apply") {
    const blocked = decision.state === "blocked";
    return out({
      state: decision.state,
      ...(blocked ? { reason: decision.reason } : {}),
      ...(decision.findings ? { findings: decision.findings.map((f) => ({ node: f.node, rule: f.rule, message: f.message })) } : {}),
      ...facts,
    }, blocked ? 1 : 0);
  }
  if (!asJson) printPlan(plan);
  if (decision.state === "blocked" && decision.reason === "conflict") {
    console.error("\nConflicts: the edited copies disagree, so nothing can be applied:");
    plan.conflicts.forEach((c) => console.error("  x " + c.detail));
    return 1;
  }
  if (decision.state === "nothing") return 0;
  if (decision.state === "blocked" && decision.reason === "changed-meanwhile") {
    console.error(`\nRefusing: ${plan.manifest.workflowFile} changed after the chamber opened, so these edits may not fit it any more.\nRun ui again, or add --force if you know it is safe.`);
    return 1;
  }
  if (decision.state === "blocked") {
    console.error("\nRefusing: the result would fail the readiness scan, so nothing was written:");
    findings.forEach((f) => console.error(`  x ${f.node} (${f.where}): ${f.message}`));
    return 1;
  }
  if (decision.state === "ready") {
    console.log(`\nDry run: nothing was changed. Re-run with --apply to update ${plan.manifest.workflowFile}.`);
    return 0;
  }
  try {
    const target = path.resolve(ROOT, plan.manifest.workflowFile);
    const after = JSON.stringify(plan.merged, null, 2) + "\n";
    // Keep a copy of what is about to be overwritten, so `undo` can put it back. If the copy cannot be kept, nothing is written.
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(UNDO_FILE, JSON.stringify(makeRecord({
      workflowFile: plan.manifest.workflowFile, workflowDir: plan.manifest.workflowDir, before: fs.readFileSync(target, "utf8"),
      after, changes: facts.changes, at: new Date().toISOString(),
    }), null, 2));
    fs.writeFileSync(target, after);
  } catch (e) {
    if (asJson) return out({ state: "write-failed", message: e.message, ...facts }, 1);
    console.error(`\nCould not write ${plan.manifest.workflowFile}: ${e.message}`);
    return 1;
  }
  if (asJson) return out({ state: "applied", ...facts }, 0);
  console.log(`\nUpdated ${plan.manifest.workflowFile}. Next: run check, look at git diff, then open a pull request.`);
  return 0;
}

// ---------- undo: put back the file as it was before the last `pull --apply` ----------
// Only if nobody has touched the file since (see backup.mjs). One step back: the copy is kept until the next apply.
function runUndo() {
  const asJson = args.includes("--json");
  const say = (obj, code) => { if (asJson) console.log(JSON.stringify(obj)); else console.log(obj.message ?? obj.state); return code; };
  let record = null;
  try { record = JSON.parse(fs.readFileSync(UNDO_FILE, "utf8")); } catch { /* no record: nothing to undo */ }
  const target = record && safeRelative(record.workflowFile) ? path.resolve(ROOT, record.workflowFile) : null;
  const current = target && fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
  const currentTests = {};
  for (const t of record?.tests ?? []) if (safeRelative(t.file) && fs.existsSync(path.resolve(ROOT, t.file))) currentTests[t.file] = fs.readFileSync(path.resolve(ROOT, t.file), "utf8");
  const decision = decideUndo({ record, currentText: current, currentTests });
  const facts = record ? { workflow: record.workflowDir, changes: record.changes, testsRestored: (record.tests ?? []).length, at: record.at } : {};
  if (decision.state !== "restore") return say({ state: decision.state, ...facts, message: `Nothing was undone (${decision.state}).` }, decision.state === "already-undone" ? 0 : 1);
  try {
    fs.writeFileSync(target, decision.text);
    for (const t of decision.tests) fs.writeFileSync(path.resolve(ROOT, t.file), t.text);
    fs.rmSync(UNDO_FILE, { force: true });
  } catch (e) { return say({ state: "write-failed", message: e.message, ...facts }, 1); }
  return say({ state: "restored", ...facts, message: `Restored ${record.workflowFile}.` }, 0);
}

// ---------- tests-fix: update tests that only fail because they still expect the wording the person changed ----------
// Dry run unless --apply. Only a line whose failure is fully explained by the last applied change is touched (testfix.mjs);
// every other failure is reported and left alone. The old text is kept in the undo record, so `undo` takes it back too.
function replaceAssertion(text, oldLine, newLine) {
  const doc = parseDocument(text);
  const seq = doc.get("assert");
  const item = seq?.items?.find((i) => i?.value === oldLine);
  if (!item) return null;
  item.value = newLine;
  item.type = /["']/.test(newLine) ? "QUOTE_SINGLE" : item.type;
  return String(doc);
}

function runTestsFix(wf) {
  const asJson = args.includes("--json");
  const out = (obj, code) => { console.log(asJson ? JSON.stringify(obj) : (obj.message ?? obj.state)); return code; };
  let record = null;
  try { record = JSON.parse(fs.readFileSync(UNDO_FILE, "utf8")); } catch { /* nothing recorded */ }
  if (!record) return out({ state: "no-change", message: "No applied change is recorded, so there is nothing to explain a failing test with." }, 1);
  if (rel(wfDir) !== record.workflowDir) return out({ state: "wrong-workflow", expected: record.workflowDir, given: rel(wfDir) }, 2);
  let tests;
  if (flag("--from-report")) { try { tests = JSON.parse(fs.readFileSync(path.resolve(flag("--from-report")), "utf8")).tests; } catch (e) { return out({ state: "failed", message: "Could not read the report: " + e.message }, 2); } }
  else tests = runTests(wf);
  const plan = planTestUpdates({ tests: tests ?? [], changes: record.changes });
  const facts = { workflow: record.workflowDir, updates: plan.updates.map((u) => ({ test: u.test, file: u.file, from: u.from, to: u.to })), unexplained: plan.unexplained };
  if (!plan.updates.length) return out({ state: plan.unexplained.length ? "unexplained" : "nothing", ...facts, message: "No test line can be updated." }, plan.unexplained.length ? 1 : 0);
  if (!args.includes("--apply")) return out({ state: "ready", ...facts, message: `${plan.updates.length} test line(s) can be updated. Re-run with --apply.` }, 0);
  // Work everything out first; write only if every file rewrites cleanly and the undo record can be kept.
  const byFile = new Map();
  for (const u of plan.updates) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u]);
  const files = [];
  for (const [file, edits] of byFile) {
    const rp = rel(path.join(wfDir, "tests", file));
    const before = fs.readFileSync(path.join(wfDir, "tests", file), "utf8");
    const r = rewriteTestText(before, edits, replaceAssertion);
    if (r.error) return out({ state: "write-failed", message: r.error, ...facts }, 1);
    try { parseYaml(r.text); } catch (e) { return out({ state: "write-failed", message: "The updated test would not be valid: " + e.message, ...facts }, 1); }
    files.push({ file: rp, abs: path.join(wfDir, "tests", file), before, after: r.text });
  }
  try {
    fs.writeFileSync(UNDO_FILE, JSON.stringify(addTestEdits(record, files), null, 2));
    for (const f of files) fs.writeFileSync(f.abs, f.after);
  } catch (e) { return out({ state: "write-failed", message: e.message, ...facts }, 1); }
  return out({ state: "applied", ...facts, message: "Updated." }, 0);
}

// ---------- report ----------
function report(wf, s, st, tests) {
  const ok = (b) => (b ? "PASS" : "FAIL");
  const passCount = tests ? tests.filter((t) => t.pass).length : 0;
  const allPass = (!s || !s.length) && (!st || !st.length) && (!tests || passCount === tests.length);
  const lines = [`# n8n-dev report: ${wf.name}`, "", `**Result: ${allPass ? "PASS: safe to review" : "FAIL: merge blocked"}**`, ""];
  lines.push("| Check | Result | Details |", "| --- | --- | --- |");
  if (s) lines.push(`| Readiness scan | ${ok(!s.length)} | ${s.length} finding(s) |`);
  if (st) lines.push(`| Structure check | ${ok(!st.length)} | ${st.length} problem(s) |`);
  if (tests) lines.push(`| Fake tests | ${ok(passCount === tests.length)} | ${passCount}/${tests.length} passed |`);
  if (s?.length) { lines.push("", "## Readiness findings", ""); s.forEach((x) => lines.push(`- **${x.node}** (\`${x.where}\`): ${x.message}`)); }
  if (st?.length) { lines.push("", "## Structure problems", ""); st.forEach((x) => lines.push(`- **${x.node}**: ${x.message}`)); }
  if (tests) {
    lines.push("", "## Tests");
    for (const t of tests) {
      lines.push("", `### ${ok(t.pass)}: ${t.name}`, "", `File \`${t.file}\`${t.seconds ? ` · ${t.seconds}s` : ""}${t.path ? ` · path: ${t.path.join(" → ")}` : ""}`, "");
      if (t.error) lines.push(`- ERROR: ${t.error}`);
      t.checks.forEach((c) => lines.push(`- ${c.pass ? "✅" : "❌"} \`${c.assertion}\` (${c.detail})`));
    }
  }
  return { allPass, md: lines.join("\n") + "\n" };
}

// ---------- main ----------
if (cmd === "init") { (await import("./init.mjs")).init(ROOT, args.slice(1)); process.exit(0); }
if (cmd === "pull") process.exit(runPull());
if (cmd === "ui-stop") process.exit(runUiStop());
if (cmd === "undo") process.exit(runUndo());
if (cmd === "status") {   // is a sealed editor still open? Exit 0 = clean, 1 = something is there, 2 = could not tell
  process.exit(spawnSync("bash ./scripts/n8n-chamber.sh status", { shell: SHELL, cwd: ROOT, stdio: "inherit" }).status ?? 2);
}
if (!["scan", "structure", "test", "check", "ui", "tests-fix"].includes(cmd) || !wfDir) {
  console.log("usage: n8n-dev <scan|structure|test|check|ui|pull|tests-fix> <workflow-dir> [--workflow-file file.json] [--report out.md] [--port 5678] [--detach] [--json]\n   or: n8n-dev ui-stop [--json] | undo [--json] | status");
  process.exit(2);
}
const wf = JSON.parse(fs.readFileSync(wfFile, "utf8"));
if (cmd === "ui") { openUi(wf); process.exit(0); }
if (cmd === "tests-fix") process.exit(runTestsFix(wf));
const s =["scan", "check"].includes(cmd) ? scan(wf) : null;
const st = ["structure", "check"].includes(cmd) ? structure(wf) : null;
const tests = ["test", "check"].includes(cmd) ? runTests(wf) : null;
const { allPass, md } = report(wf, s, st, tests);
// --json prints the facts as one JSON object (for programs such as the MCP server) instead of the readable report.
console.log(args.includes("--json") ? JSON.stringify({ allPass, workflow: rel(wfDir), scan: s, structure: st, tests }) : md);
const out = flag("--report");
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, md); fs.writeFileSync(out.replace(/\.md$/, ".json"), JSON.stringify({ allPass, scan: s, structure: st, tests }, null, 2)); }
process.exit(allPass ? 0 : 1);
