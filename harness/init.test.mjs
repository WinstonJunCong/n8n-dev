// Regression test for `init`: a generated repo must contain everything its own harness needs.
// Run with: npm test   (no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { init } from "./init.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generate = () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-init-"));
  const log = console.log;
  console.log = () => {};                         // init prints its next steps; keep test output clean
  try { init(ROOT, [target, "--workflows-dir", "flows"]); } finally { console.log = log; }
  return target;
};
const filesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name).sort();

test("a generated repo has every harness, mcp and script file", () => {
  const target = generate();
  try {
    for (const folder of ["harness", "mcp", "scripts"]) {
      assert.deepEqual(filesIn(path.join(target, folder)), filesIn(path.join(ROOT, folder)), `${folder}/ differs in the generated repo`);
    }
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("every relative import in the generated harness and mcp folders resolves", () => {
  const target = generate();
  try {
    for (const folder of ["harness", "mcp"]) {
      const dir = path.join(target, folder);
      for (const file of filesIn(dir).filter((f) => f.endsWith(".mjs"))) {
        const source = fs.readFileSync(path.join(dir, file), "utf8");
        for (const m of source.matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) {
          assert.ok(fs.existsSync(path.join(dir, m[1])), `${folder}/${file} imports ${m[1]}, which is missing in the generated repo`);
        }
      }
    }
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("the generated package.json test script points at files that exist", () => {
  const target = generate();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    for (const f of pkg.scripts.test.match(/(?:harness|mcp)\/[\w.-]+\.mjs/g) || []) {
      assert.ok(fs.existsSync(path.join(target, f)), `npm test refers to ${f}, which is missing in the generated repo`);
    }
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("the generated repo keeps shell scripts on Unix line endings", () => {
  const target = generate();
  try {
    assert.match(fs.readFileSync(path.join(target, ".gitattributes"), "utf8"), /\*\.sh text eol=lf/);
    for (const f of filesIn(path.join(target, "scripts"))) assert.ok(!fs.readFileSync(path.join(target, "scripts", f), "utf8").includes("\r"));
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

// The strongest check: run the generated repo's own unit tests inside it. A repo whose own `npm test` fails would
// turn its CI red on the very first run. The env guard stops the tests inside from generating yet another repo.
test("the generated repo's own unit tests pass inside it", {
  skip: process.env.N8N_DEV_NESTED_TEST ? "already running inside a generated repo" : false,
}, () => {
  const target = generate();
  try {
    const tests = ["harness", "mcp"].flatMap((folder) =>
      filesIn(path.join(target, folder)).filter((f) => f.endsWith(".test.mjs")).map((f) => `${folder}/${f}`));
    // NODE_TEST_CONTEXT is set by the outer test runner. If it were inherited, the inner `node --test` would not act
    // as a runner and would exit 0 even when tests fail (a false pass).
    const env = { ...process.env, N8N_DEV_NESTED_TEST: "1" };
    delete env.NODE_TEST_CONTEXT;
    // The generated repo would run `npm install` first; a plain copy of the installed packages stands in for that
    // (a copy, not a link, so cleaning up can never reach the real ones).
    fs.cpSync(path.join(ROOT, "node_modules"), path.join(target, "node_modules"), { recursive: true });
    const r = spawnSync(process.execPath, ["--test", ...tests], { cwd: target, encoding: "utf8", env });
    const failures = (r.stdout + r.stderr).slice(-1500);
    assert.equal(r.status, 0, `the generated repo's tests failed:\n${failures}`);
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("the generated CI is this repo's CI, and it runs the unit tests", () => {
  const target = generate();
  try {
    const mine = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
    const theirs = fs.readFileSync(path.join(target, ".github/workflows/ci.yml"), "utf8");
    assert.equal(theirs, mine);                       // same default version, so they must be identical
    assert.match(theirs, /run: npm test/);
    assert.match(theirs, /Find the workflows this pull request affects/);
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("CI installs the packages before it runs the unit tests (the MCP server's tests need them)", () => {
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const install = ci.indexOf("run: npm ci");
  const tests = ci.indexOf("run: npm test");
  assert.ok(install !== -1, "ci.yml has no `npm ci` step");
  assert.ok(tests !== -1, "ci.yml has no `npm test` step");
  assert.ok(install < tests, "`npm ci` must come before `npm test`");
  assert.equal(ci.split("run: npm ci").length - 1, 1, "install once, not twice");
});
