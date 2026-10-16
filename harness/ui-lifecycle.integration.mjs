// Integration test for `ui --detach` and `ui-stop`, using the real command line and real Docker.
// Not part of `npm test` (it needs Docker Desktop and takes about a minute). Run it with: npm run test:integration
//
// It walks the whole lifecycle an assistant would: start without a terminal, refuse a second start, sign in with the
// throwaway login, stop and save, check everything is gone, and stop again with nothing running.
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
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};
const cli = (...args) => run(process.execPath, ["harness/n8n-dev.mjs", ...args]);
const chamber = (...args) => run("bash", ["./scripts/n8n-chamber.sh", ...args]);

before(() => {
  assert.equal(chamber("status").status, 0, "A chamber is already running. Run `bash ./scripts/n8n-chamber.sh down` first.");
});
after(() => { chamber("down"); });   // always clean up, even when a step fails

test("ui --detach returns, prints the address and the login, and leaves the chamber running", () => {
  const r = cli("ui", WORKFLOW, "--detach");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /READY http:\/\/127\.0\.0\.1:5678/);
  assert.match(r.out, /test@test\.com/);
  assert.match(r.out, /ui-stop/);
  assert.equal(chamber("status").status, 1, "the chamber should be running now");
});

test("a second start is refused while one is running, and the first keeps running", () => {
  const r = cli("ui", WORKFLOW, "--detach");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /already running/);
  assert.equal(chamber("status").status, 1, "the first chamber must be untouched");
});

test("the throwaway login works against the running chamber", async () => {
  const res = await fetch("http://127.0.0.1:5678/rest/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailOrLdapLoginId: "test@test.com", password: "Test1234" }),
  });
  assert.equal(res.status, 200);
});

test("ui-stop saves the workflows, summarises them, and removes everything", () => {
  const r = cli("ui-stop");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Saved the workflows/);
  assert.match(r.out, /CLEAN/);
  assert.match(r.out, /No changes to pull/);                  // nothing was edited in this run
  const saved = fs.readdirSync(path.join(ROOT, ".n8n-dev/ui-export")).filter((f) => f.endsWith(".json"));
  assert.equal(saved.length, 3, `expected one saved copy per test, found: ${saved.join(", ")}`);
  assert.equal(chamber("status").status, 0, "nothing should be left behind");
});

test("ui-stop with nothing running says so, saves nothing, and still reports clean", () => {
  const r = cli("ui-stop");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /No chamber was running, so nothing was saved/);
  assert.doesNotMatch(r.out, /No changes to pull/);           // must not re-describe the previous session
});

test("ui-stop with no recorded session explains what to do", () => {
  const manifest = path.join(ROOT, ".n8n-dev/ui-manifest.json");
  const kept = fs.readFileSync(manifest);
  try {
    fs.rmSync(manifest);
    const r = cli("ui-stop");
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /No chamber session found/);
  } finally { fs.writeFileSync(manifest, kept); }
});
