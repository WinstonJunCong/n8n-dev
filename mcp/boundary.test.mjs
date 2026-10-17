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

// ---------- the protocol channel and the outside packages ----------
const nonTest = () => sources("mcp", (f) => !f.endsWith(".test.mjs"));
const importsOf = (code) => [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);

test("nothing in mcp/ writes to standard output: only protocol messages may go there", () => {
  for (const { file, text } of nonTest()) {
    const code = stripComments(text);
    assert.ok(!/\bconsole\s*\.\s*(?:log|info|debug)\s*\(/.test(code), `${file} prints with console.log/info/debug`);
    assert.ok(!/\bprocess\s*\.\s*stdout\b/.test(code), `${file} touches process.stdout`);
  }
});

test("server.mjs imports the stdout guard first, before anything can load and print", () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, "mcp/server.mjs"), "utf8"));
  assert.equal(importsOf(code)[0], "./stdout-guard.mjs");
});

test("the guard redirects console.log, info and debug to standard error", () => {
  const code = fs.readFileSync(path.join(ROOT, "mcp/stdout-guard.mjs"), "utf8");
  for (const name of ["log", "info", "debug"]) assert.match(code, new RegExp(`"${name}"`));
  assert.match(code, /console\.error/);
});

test("mcp/ uses only Node's own modules, its own files, and the three allowed packages", () => {
  const allowed = new Set(["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio", "zod/v4"]);
  for (const { file, text } of nonTest()) {
    for (const spec of importsOf(stripComments(text))) {
      const fine = spec.startsWith("node:") || spec.startsWith("./") || allowed.has(spec);
      assert.ok(fine, `${file} imports "${spec}", which is not on the allowed list`);
    }
  }
});

test("only server.mjs touches the MCP library, so the tools stay independent of it", () => {
  for (const { file, text } of nonTest().filter((s) => s.file !== "mcp/server.mjs")) {
    assert.ok(!/@modelcontextprotocol\//.test(stripComments(text)), `${file} imports the MCP library`);
  }
});
