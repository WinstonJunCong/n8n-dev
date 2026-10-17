// Unit tests for harness/shell.mjs. Run with: npm test   (no Windows, no Docker needed)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBash, gitRootOf } from "./shell.mjs";

const existing = (...paths) => (p) => paths.includes(p);
const WIN = (extra = {}) => ({ platform: "win32", env: {}, gitPaths: [], exists: () => false, ...extra });
const WSL = "C:\\Windows\\System32\\bash.exe";

// ---------- gitRootOf ----------
test("gitRootOf finds the Git for Windows folder from where git.exe is", () => {
  assert.equal(gitRootOf("D:\\Program Files\\Git\\mingw64\\bin\\git.EXE"), "D:\\Program Files\\Git");
  assert.equal(gitRootOf("C:\\Program Files\\Git\\cmd\\git.exe"), "C:\\Program Files\\Git");
  assert.equal(gitRootOf("C:\\Program Files\\Git\\bin\\git.exe"), "C:\\Program Files\\Git");
  assert.equal(gitRootOf("  E:\\Tools\\Git\\mingw32\\bin\\git.exe \r"), "E:\\Tools\\Git");
});

test("gitRootOf returns null for paths that are not a Git for Windows layout", () => {
  for (const p of ["C:\\Tools\\git.exe", WSL, "", "git"]) assert.equal(gitRootOf(p), null, p);
});

// ---------- findBash ----------
test("outside Windows the normal shell is used", () => {
  assert.deepEqual(findBash({ platform: "linux", exists: () => false }), { shell: true });
  assert.deepEqual(findBash({ platform: "darwin", exists: () => false }), { shell: true });
});

test("inside a Git Bash window, EXEPATH is used first", () => {
  const r = findBash(WIN({ env: { EXEPATH: "D:\\Program Files\\Git\\bin" }, exists: existing("D:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe") }));
  assert.deepEqual(r, { shell: "D:\\Program Files\\Git\\bin\\bash.exe" });
});

test("started by an app (no EXEPATH), Git Bash is found from where git.exe is, and WSL is passed over (the real failure)", () => {
  // X:\Tools is somewhere no search list could guess, so only reading it from git.exe's location can find this.
  const r = findBash(WIN({
    gitPaths: ["X:\\Tools\\Git\\mingw64\\bin\\git.EXE"],
    exists: existing("X:\\Tools\\Git\\bin\\bash.exe", WSL),
  }));
  assert.deepEqual(r, { shell: "X:\\Tools\\Git\\bin\\bash.exe" });
});

test("the exact machine this was found on: Git on D:, no EXEPATH, WSL present", () => {
  const r = findBash(WIN({
    gitPaths: ["D:\\Program Files\\Git\\mingw64\\bin\\git.EXE"],
    exists: existing("D:\\Program Files\\Git\\bin\\bash.exe", WSL),
  }));
  assert.deepEqual(r, { shell: "D:\\Program Files\\Git\\bin\\bash.exe" });
});

test("Git installed on another drive is found without being told where", () => {
  assert.deepEqual(findBash(WIN({ exists: existing("E:\\Program Files\\Git\\bin\\bash.exe") })), { shell: "E:\\Program Files\\Git\\bin\\bash.exe" });
});

test("the ProgramFiles folders and the per-user install folder are searched", () => {
  assert.deepEqual(findBash(WIN({ env: { ProgramFiles: "X:\\Apps" }, exists: existing("X:\\Apps\\Git\\bin\\bash.exe") })), { shell: "X:\\Apps\\Git\\bin\\bash.exe" });
  assert.deepEqual(findBash(WIN({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, exists: existing("C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe") })),
    { shell: "C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe" });
  assert.deepEqual(findBash(WIN({ env: { GIT_INSTALL_ROOT: "Z:\\Git" }, exists: existing("Z:\\Git\\bin\\bash.exe") })), { shell: "Z:\\Git\\bin\\bash.exe" });
});

test("bin\\bash.exe is preferred over usr\\bin\\bash.exe, and usr\\bin is the fallback", () => {
  const both = findBash(WIN({ gitPaths: ["C:\\Program Files\\Git\\cmd\\git.exe"], exists: existing("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe") }));
  assert.equal(both.shell, "C:\\Program Files\\Git\\bin\\bash.exe");
  const only = findBash(WIN({ gitPaths: ["C:\\Program Files\\Git\\cmd\\git.exe"], exists: existing("C:\\Program Files\\Git\\usr\\bin\\bash.exe") }));
  assert.equal(only.shell, "C:\\Program Files\\Git\\usr\\bin\\bash.exe");
});

test("WSL's bash is never used, even when it is the only bash there is", () => {
  const r = findBash(WIN({ exists: existing(WSL) }));
  assert.ok(r.error);
  assert.match(r.error, /Git Bash was not found/);
  assert.match(r.error, /WSL/);
  assert.match(r.error, /git-scm\.com/);
  assert.equal(r.shell, undefined);
});

test("WSL's bash is refused even if something points EXEPATH or a Git folder at it", () => {
  assert.ok(findBash(WIN({ env: { EXEPATH: "C:\\Windows\\System32" }, exists: existing(WSL) })).error);
  assert.ok(findBash(WIN({ env: { GIT_INSTALL_ROOT: "C:\\Windows" }, exists: existing("C:\\Windows\\bin\\bash.exe", WSL) })).shell !== WSL);
  for (const variant of ["C:\\WINDOWS\\SYSTEM32\\BASH.EXE", "C:\\Windows\\Sysnative\\bash.exe", "C:\\Windows\\SysWOW64\\bash.exe"]) {
    assert.ok(findBash(WIN({ env: { EXEPATH: path.win32.dirname(variant) }, exists: existing(variant) })).error, variant);
  }
});

test("when nothing is installed the error says what to do", () => {
  const r = findBash(WIN());
  assert.match(r.error, /Install Git for Windows/);
  assert.match(r.error, /Git Bash window/);
});

// ---------- wiring ----------
test("the command line uses findBash, and no longer falls back to the plain name `bash`", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "n8n-dev.mjs"), "utf8");
  assert.match(source, /import\s*\{\s*findBash\s*\}\s*from\s*"\.\/shell\.mjs"/);
  assert.match(source, /findBash\(\s*\{/);
  assert.doesNotMatch(source, /\?\s*"bash"\s*:\s*true/, "the old fallback to a bare `bash` must be gone");
});
