// Tests for mcp/effects.mjs: the only code that touches the disk or starts a process. Uses a throwaway folder with a
// fake n8n-dev program, so no Docker and nothing real is run. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFs, makeRunner } from "./effects.mjs";

// A throwaway "repository" whose harness/n8n-dev.mjs reports how it was called.
const makeRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-mcp-"));
  fs.mkdirSync(path.join(root, "harness"));
  fs.mkdirSync(path.join(root, "workflows", "demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "workflows", "demo", "workflow.json"), '{"hello":"world"}');
  fs.writeFileSync(path.join(root, "harness", "n8n-dev.mjs"), `
    if (process.env.FAKE_HANG) setTimeout(() => {}, 60000);
    else if (process.env.FAKE_BIG) { process.stdout.write("A".repeat(3_000_000) + "THE-END"); }
    else { console.log(JSON.stringify({ args: process.argv.slice(2), n8nCmd: process.env.N8N_CMD ?? null, cwd: process.cwd() })); process.stderr.write("on stderr\\n"); process.exit(Number(process.env.FAKE_EXIT ?? 0)); }
  `);
  return root;
};

// ---------- makeFs ----------
test("makeFs reads, checks and lists files inside the repository", () => {
  const root = makeRepo();
  const fsx = makeFs(root);
  assert.equal(fsx.exists("workflows/demo/workflow.json"), true);
  assert.equal(fsx.exists("workflows/nope"), false);
  assert.equal(fsx.readText("workflows/demo/workflow.json"), '{"hello":"world"}');
  assert.deepEqual(fsx.listDir("workflows"), [{ name: "demo", isFile: false, isDirectory: true }]);
});

test("makeFs refuses any path that leaves the repository", () => {
  const fsx = makeFs(makeRepo());
  const outside = path.resolve(os.tmpdir(), "outside.txt");
  const attacks = ["../outside.txt", "../../etc/passwd", "workflows/../../x", outside, "/etc/hosts", "workflows/demo/../../../x"];
  // A drive path is only an absolute path on Windows; elsewhere it is just an odd file name inside the repository.
  if (process.platform === "win32") attacks.push("C:\\Windows\\win.ini", "\\\\server\\share\\x");
  for (const p of attacks) {
    assert.throws(() => fsx.readText(p), /outside the repository/, p);
    assert.throws(() => fsx.exists(p), /outside the repository/, p);
    assert.throws(() => fsx.listDir(p), /outside the repository/, p);
  }
});

test("a sibling folder whose name starts like the repository's is still outside", () => {
  const root = makeRepo();
  const sibling = `${root}-evil`;
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "secret.txt"), "secret");
  const fsx = makeFs(root);
  assert.throws(() => fsx.readText(`../${path.basename(sibling)}/secret.txt`), /outside the repository/);
});

// ---------- makeRunner ----------
test("the runner starts the harness with exactly the given arguments, from the repository root", async () => {
  const root = makeRepo();
  const runCli = makeRunner({ root });
  const r = await runCli(["check", "workflows/demo"], { env: { N8N_CMD: "./scripts/n8n-docker.sh" } });
  assert.equal(r.status, 0);
  const seen = JSON.parse(r.out.split("\n")[0]);
  assert.deepEqual(seen.args, ["check", "workflows/demo"]);
  assert.equal(seen.n8nCmd, "./scripts/n8n-docker.sh");
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(root));
  assert.match(r.out, /on stderr/);                    // standard error is captured too
});

test("an argument that looks like a shell command is passed through as plain text and never run", async () => {
  const root = makeRepo();
  const runCli = makeRunner({ root });
  const marker = path.join(root, "HACKED");
  const evil = [`; touch ${marker}`, `$(touch ${marker})`, `\`touch ${marker}\``, `&& touch ${marker}`, `| touch ${marker}`, "a b", "*", "\n"];
  const r = await runCli(evil);
  const seen = JSON.parse(r.out.split("\n")[0]);
  assert.deepEqual(seen.args, evil, "every argument must arrive exactly as given");
  assert.equal(fs.existsSync(marker), false, "nothing may have been executed");
});

test("the runner passes the exit status through", async () => {
  const runCli = makeRunner({ root: makeRepo() });
  assert.equal((await runCli(["x"], { env: { FAKE_EXIT: "1" } })).status, 1);
  assert.equal((await runCli(["x"], { env: { FAKE_EXIT: "2" } })).status, 2);
});

test("a command that runs too long is stopped and reported, not left running", async () => {
  const runCli = makeRunner({ root: makeRepo() });
  const started = Date.now();
  const r = await runCli(["x"], { timeoutMs: 400, env: { FAKE_HANG: "1" } });
  assert.equal(r.timedOut, true);
  assert.equal(r.status, null);
  assert.match(r.out, /stopped: it took longer than/);
  assert.ok(Date.now() - started < 10_000, "it must not wait for the 60 second sleep");
});

test("huge output is capped, keeping the end where the result is", async () => {
  const runCli = makeRunner({ root: makeRepo(), maxOutput: 100_000 });
  const r = await runCli(["x"], { env: { FAKE_BIG: "1" } });
  assert.ok(r.out.length <= 100_000);
  assert.ok(r.out.endsWith("THE-END"));
});

test("a program that cannot be started is reported as a result, never thrown", async () => {
  const runCli = makeRunner({ root: makeRepo(), nodePath: path.join(os.tmpdir(), "no-such-node-binary") });
  const r = await runCli(["x"]);
  assert.equal(r.status, null);
  assert.match(r.out, /Could not start n8n-dev/);
});
