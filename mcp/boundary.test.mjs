// Architecture tests: two rules that keep the MCP server safe and the core independent.
// Run with: npm test   (no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = (dir, keep = () => true) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".mjs") && keep(f))
    .map((f) => ({ file: `${dir}/${f}`, text: fs.readFileSync(path.join(ROOT, dir, f), "utf8") }));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the core (harness/) never imports from mcp/", () => {
  for (const { file, text } of sources("harness")) {
    // Catches `from "x"`, `import("x")` and the bare `import "x"`.
    assert.ok(!/(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*\bmcp\//.test(stripComments(text)), `${file} imports from mcp/`);
  }
});

test("only effects.mjs may start a process or touch the disk; the rules and the tools stay free of both", () => {
  for (const { file, text } of sources("mcp", (f) => !f.endsWith(".test.mjs") && f !== "effects.mjs")) {
    const code = stripComments(text);
    assert.ok(!/node:child_process|["']child_process["']/.test(code), `${file} imports child_process`);
    assert.ok(!/from\s*["'](?:node:)?fs(?:\/promises)?["']/.test(code), `${file} imports fs`);
  }
});

test("effects.mjs starts programs only with an argument list and shell: false", () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, "mcp/effects.mjs"), "utf8"));
  assert.match(code, /shell:\s*false/);
  assert.ok(!/\bexec(?:Sync|File|FileSync)?\s*\(/.test(code), "effects.mjs must use spawn only");
  assert.ok(!/\bspawnSync\b/.test(code), "effects.mjs must not block the server");
});

test("mcp/ never runs shell strings: no exec, no shell option, no eval", () => {
  const forbidden = [
    [/\bexec(?:Sync|File|FileSync)?\s*\(/, "exec / execSync / execFile"],
    [/\bshell\s*:\s*(?!false\b)\S/, "a shell option other than false"],   // the trailing \S stops backtracking from flagging `shell: false`
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\s*\(/, "new Function"],
  ];
  for (const { file, text } of sources("mcp", (f) => !f.endsWith(".test.mjs"))) {
    const code = stripComments(text);
    for (const [re, label] of forbidden) assert.ok(!re.test(code), `${file} uses ${label}`);
  }
});
