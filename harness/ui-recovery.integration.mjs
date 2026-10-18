// Integration test for what happens when an editor is cut off: killed without warning, as a crash or a restart would.
// Real command line, real Docker. Not part of `npm test` (it needs Docker Desktop and takes about a minute).
// Run it with: npm run test:integration
//
// It proves the claims the assistant makes to a person: the editor's contents survive the cut-off, a new editor is
// refused instead of wiping them, the earlier editor comes back on its address, and throwing it away leaves nothing.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = "workflows/site-health-alert";
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "" };
};
const cli = (...args) => run(process.execPath, ["harness/n8n-dev.mjs", ...args]);
const chamber = (...args) => run("bash", ["./scripts/n8n-chamber.sh", ...args]);
const json = (r) => JSON.parse(r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop());
const login = () => fetch("http://127.0.0.1:5678/rest/login", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ emailOrLdapLoginId: "test@test.com", password: "Test1234" }),
});

before(() => {
  const s = chamber("status");
  assert.equal(s.status, 0,
    `A chamber is already running (or something from one is left over), so this test will not start.\n${s.out}\n` +
    "Close it with ui-stop, or remove it with `bash ./scripts/n8n-chamber.sh down`, then run the test again.");
});
after(() => { chamber("down"); });

test("an editor that is cut off without warning is still there, and is described as stopped", () => {
  const started = cli("ui", WORKFLOW, "--detach", "--json");
  assert.equal(started.status, 0, started.out);
  assert.equal(json(started).state, "started");
  assert.equal(chamber("state").stdout.trim(), "running");
  run("docker", ["kill", "n8n-chamber-app"]);                  // the editor dies at once, with no chance to save or clean up
  run("docker", ["stop", "n8n-chamber-fwd"]);
  assert.equal(chamber("state").stdout.trim(), "stopped");
  const s = json(cli("session", "--json"));
  assert.equal(s.kind, "editor-stopped");
  assert.equal(s.workflow, WORKFLOW);
  assert.equal(s.age, "just now");
  assert.equal(chamber("status").status, 1, "its containers and data are still there");
});

test("a new editor is refused while the cut-off one is still there, with the choices, and nothing is touched", () => {
  const r = cli("ui", WORKFLOW, "--detach", "--json");
  assert.equal(r.status, 1, r.out);
  const j = json(r);
  assert.equal(j.state, "already-running");
  assert.equal(j.session.kind, "editor-stopped");
  assert.equal(chamber("state").stdout.trim(), "stopped", "the earlier editor must be exactly as it was");
});

test("ui-resume brings the earlier editor back on its address, with its contents", async () => {
  const r = cli("ui-resume", "--json");
  assert.equal(r.status, 0, r.out);
  const j = json(r);
  assert.equal(j.state, "resumed");
  assert.equal(j.address, "http://127.0.0.1:5678");
  assert.equal(chamber("state").stdout.trim(), "running");
  const res = await login();
  assert.equal(res.status, 200, "the throwaway login still works: the account survived the cut-off");
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  const list = await (await fetch("http://127.0.0.1:5678/rest/workflows", { headers: { cookie } })).json();
  const names = (list.data ?? list).map((w) => w.name);
  assert.equal(names.filter((n) => String(n).startsWith("[test]")).length, 3, `the three test copies survived: ${names.join(", ")}`);
});

test("ui-discard throws everything away and leaves nothing behind, without touching the workflow or its tests", () => {
  const before = fs.readFileSync(path.join(ROOT, WORKFLOW, "workflow.json"), "utf8");
  const r = cli("ui-discard", "--json");
  assert.equal(r.status, 0, r.out);
  const j = json(r);
  assert.equal(j.state, "discarded");
  assert.equal(j.cleaned, true);
  assert.equal(chamber("status").status, 0, "nothing is left");
  assert.equal(fs.existsSync(path.join(ROOT, ".n8n-dev/ui-manifest.json")), false);
  assert.equal(fs.existsSync(path.join(ROOT, ".n8n-dev/ui-export")), false);
  assert.equal(fs.readFileSync(path.join(ROOT, WORKFLOW, "workflow.json"), "utf8"), before);
  assert.equal(json(cli("session", "--json")).kind, "none");
});

test("ui-resume with nothing there says so", () => {
  const r = cli("ui-resume", "--json");
  assert.equal(r.status, 1, r.out);
  assert.equal(json(r).state, "nothing-to-resume");
});
