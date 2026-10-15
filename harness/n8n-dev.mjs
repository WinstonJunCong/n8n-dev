#!/usr/bin/env node
// n8n-dev: proof-of-concept test harness for governed n8n development.
//   n8n-dev scan      <workflow-dir> [--workflow-file f.json]   readiness scan (no live IDs, keys, hosts)
//   n8n-dev structure <workflow-dir> [--workflow-file f.json]   valid nodes, versions, connections
//   n8n-dev test      <workflow-dir> [--workflow-file f.json]   run YAML tests with every outside step faked
//   n8n-dev check     <workflow-dir> [--workflow-file f.json]   all three + markdown/JSON report (what CI runs)
// The n8n CLI is taken from $N8N_CMD (default "n8n"). Each run uses a fresh, throwaway n8n data folder,
// so nothing touches a real n8n, real credentials or real services.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/readiness.json"), "utf8"));
const N8N_CMD = process.env.N8N_CMD || "n8n";
const N8N_VERSION = process.env.N8N_VERSION || CONFIG.n8nVersion || "2.43.4";
const WORK = path.join(ROOT, ".n8n-dev");
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
// On Windows, run N8N_CMD through Git Bash so ./scripts/n8n-docker.sh works (cmd.exe cannot run it).
function pickShell() {
  if (process.platform !== "win32") return true;
  const candidates = [process.env.EXEPATH && path.join(process.env.EXEPATH, "bash.exe"),
    "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || (/\.sh$/.test(N8N_CMD) ? "bash" : true);
}
const SHELL = pickShell();
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
if (!["scan", "structure", "test", "check"].includes(cmd) || !wfDir) {
  console.log("usage: n8n-dev <scan|structure|test|check> <workflow-dir> [--workflow-file file.json] [--report out.md]");
  process.exit(2);
}
const wf = JSON.parse(fs.readFileSync(wfFile, "utf8"));
const s = ["scan", "check"].includes(cmd) ? scan(wf) : null;
const st = ["structure", "check"].includes(cmd) ? structure(wf) : null;
const tests = ["test", "check"].includes(cmd) ? runTests(wf) : null;
const { allPass, md } = report(wf, s, st, tests);
console.log(md);
const out = flag("--report");
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, md); fs.writeFileSync(out.replace(/\.md$/, ".json"), JSON.stringify({ allPass, scan: s, structure: st, tests }, null, 2)); }
process.exit(allPass ? 0 : 1);
