// Runs `submit-facts` against a real throwaway Git repository (no Docker, no network): what differs from the shared
// branch, found from local data only. Skipped where Git is not installed.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull };
const git = (dir, ...args) => {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const workflow = (text) => JSON.stringify({
  name: "Demo", nodes: [
    { id: "t1", name: "Incoming", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "demo" } },
    { id: "c1", name: "Compose", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [200, 0], parameters: { text } },
  ],
  connections: { Incoming: { main: [[{ node: "Compose", type: "main", index: 0 }]] } },
}, null, 2) + "\n";
const testYaml = (name) => `test: ${name}\nassert:\n  - node "Compose" called 1 time\n`;

// A repository whose `main` has one committed workflow with two tests, plus an unrelated file.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-git-"));
  fs.cpSync(path.join(ROOT, "harness"), path.join(dir, "harness"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  write(path.join(dir, ".gitignore"), "node_modules\n.n8n-dev\n");
  write(path.join(dir, "flows/demo/workflow.json"), workflow("ALERT: down"));
  write(path.join(dir, "flows/demo/tests/01-down.yaml"), testYaml("Down site"));
  write(path.join(dir, "flows/demo/tests/02-up.yaml"), testYaml("Up site"));
  write(path.join(dir, "flows/other/workflow.json"), workflow("other"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  return dir;
}

const facts = (dir, wf = "flows/demo") => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(dir, "harness/n8n-dev.mjs"), "submit-facts", wf, "--json"], { cwd: dir, encoding: "utf8", env });
  const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
  return { status: r.status, json: line ? JSON.parse(line) : null, stderr: r.stderr };
};
const opts = { skip: !hasGit && "git is not installed" };

test("nothing differs from the shared branch in a clean repository", opts, () => {
  const r = facts(makeRepo());
  assert.equal(r.json.state, "facts", r.stderr);
  assert.equal(r.json.base, "main");
  assert.deepEqual(r.json.files, []);
  assert.equal(r.json.workflowChanged, false);
});

test("a file that differs only in Windows line endings is not a change; a real change in such a file still is", opts, () => {
  const dir = makeRepo();
  for (const f of ["flows/demo/workflow.json", "flows/demo/tests/01-down.yaml"]) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/\n/g, "\r\n"));
  }
  assert.deepEqual(facts(dir).json.files, [], "line endings alone are not a change");
  const p = path.join(dir, "flows/demo/workflow.json");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("ALERT: down", "OLALA: down"));
  assert.deepEqual(facts(dir).json.files.map((f) => f.path), ["flows/demo/workflow.json"], "control: a real change in a CRLF file is still found");
});

test("an edited workflow, edited, new and deleted tests, are all found, with the plain changes and test names", opts, () => {
  const dir = makeRepo();
  write(path.join(dir, "flows/demo/workflow.json"), workflow("OLALA: down"));
  write(path.join(dir, "flows/demo/tests/01-down.yaml"), testYaml("Down site, reworded"));
  fs.rmSync(path.join(dir, "flows/demo/tests/02-up.yaml"));
  write(path.join(dir, "flows/demo/tests/03-new.yaml"), testYaml("Brand new"));
  const r = facts(dir).json;
  assert.deepEqual(r.files.map((f) => `${f.status} ${f.path}`), [
    "M flows/demo/tests/01-down.yaml", "D flows/demo/tests/02-up.yaml", "A flows/demo/tests/03-new.yaml", "M flows/demo/workflow.json"]);
  assert.equal(r.workflowChanged, true);
  assert.deepEqual(r.workflowChanges, [{ kind: "changed", node: "Compose", details: [{ label: "text", from: "ALERT: down", to: "OLALA: down" }] }]);
  assert.deepEqual(r.tests.map((t) => [t.status, t.name]), [["M", "Down site, reworded"], ["D", "Up site"], ["A", "Brand new"]]);
});

test("changes that are already committed on a branch count too, not only uncommitted edits", opts, () => {
  const dir = makeRepo();
  git(dir, "checkout", "-q", "-b", "mine");
  write(path.join(dir, "flows/demo/workflow.json"), workflow("OLALA: down"));
  git(dir, "commit", "-q", "-am", "edit");
  const r = facts(dir).json;
  assert.deepEqual(r.files.map((f) => f.path), ["flows/demo/workflow.json"]);
});

test("the comparison is with origin/main when it exists, so a stale local main cannot hide or invent changes", opts, () => {
  const dir = makeRepo();
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  write(path.join(dir, "flows/demo/workflow.json"), workflow("moved on"));
  git(dir, "commit", "-q", "-am", "someone else changed main after");
  assert.equal(facts(dir).json.base, "origin/main");
  assert.deepEqual(facts(dir).json.files.map((f) => f.path), ["flows/demo/workflow.json"]);
});

test("other files in the folder are reported, and files in other folders are not", opts, () => {
  const dir = makeRepo();
  write(path.join(dir, "flows/demo/notes.txt"), "stray");
  write(path.join(dir, "flows/other/workflow.json"), workflow("someone else's workflow changed"));
  const r = facts(dir).json;
  assert.deepEqual(r.files.map((f) => f.path), ["flows/demo/notes.txt"]);
  assert.deepEqual(r.tests, []);
});

test("a workflow that is not on the shared branch yet is reported as new", opts, () => {
  const dir = makeRepo();
  write(path.join(dir, "flows/fresh/workflow.json"), workflow("hello"));
  write(path.join(dir, "flows/fresh/tests/01.yaml"), testYaml("Fresh test"));
  const r = facts(dir, "flows/fresh").json;
  assert.equal(r.newWorkflow, true);
  assert.equal(r.workflowChanged, true);
  assert.deepEqual(r.files.map((f) => f.status), ["A", "A"]);
});

test("without a shared branch the answer is that, not an empty list that would look like 'nothing changed'", opts, () => {
  const dir = makeRepo();
  git(dir, "branch", "-m", "main", "trunk");
  const r = facts(dir);
  assert.equal(r.json.state, "no-base");
  assert.equal(r.status, 2);
});

test("outside a Git repository the answer is that too", opts, () => {
  const dir = makeRepo();
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  assert.equal(facts(dir).json.state, "no-repo");
});

test("it only reads: the repository is exactly as it was afterwards", opts, () => {
  const dir = makeRepo();
  write(path.join(dir, "flows/demo/workflow.json"), workflow("OLALA: down"));
  const before = git(dir, "status", "--porcelain=v1") + git(dir, "rev-parse", "HEAD") + git(dir, "branch", "--list");
  facts(dir);
  assert.equal(git(dir, "status", "--porcelain=v1") + git(dir, "rev-parse", "HEAD") + git(dir, "branch", "--list"), before);
});
