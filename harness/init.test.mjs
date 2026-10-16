// Regression test for `init`: a generated repo must contain everything its own harness needs.
// Run with: npm test   (no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("a generated repo has every harness and script file", () => {
  const target = generate();
  try {
    assert.deepEqual(filesIn(path.join(target, "harness")), filesIn(path.join(ROOT, "harness")));
    assert.deepEqual(filesIn(path.join(target, "scripts")), filesIn(path.join(ROOT, "scripts")));
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("every relative import in the generated harness resolves", () => {
  const target = generate();
  try {
    const dir = path.join(target, "harness");
    for (const file of filesIn(dir).filter((f) => f.endsWith(".mjs"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const m of source.matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) {
        assert.ok(fs.existsSync(path.join(dir, m[1])), `${file} imports ${m[1]}, which is missing in the generated repo`);
      }
    }
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("the generated package.json test script points at files that exist", () => {
  const target = generate();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    for (const f of pkg.scripts.test.match(/harness\/[\w.-]+\.mjs/g) || []) {
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
