// Runs `submit` and `submit-facts --fetch` against a real throwaway Git repository with a real (local, bare) "team
// repository" as its origin: no Docker, no network. Proves the mechanics: what is pushed, where, and that nothing
// local moves. Skipped where Git is not installed.
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
const opts = { skip: !hasGit && "git is not installed" };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull };
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
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

// A working copy whose `origin` is a bare repository that already holds `main`.
function makeRepo() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dev-send-"));
  const remote = path.join(top, "team.git"), dir = path.join(top, "work");
  fs.mkdirSync(dir);
  git(top, "init", "-q", "--bare", "-b", "main", remote);
  fs.cpSync(path.join(ROOT, "harness"), path.join(dir, "harness"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  write(path.join(dir, ".gitignore"), "node_modules\n.n8n-dev\n");
  write(path.join(dir, "flows/demo/workflow.json"), workflow("ALERT: down"));
  write(path.join(dir, "flows/demo/tests/01-down.yaml"), testYaml("Down site"));
  write(path.join(dir, "flows/other/workflow.json"), workflow("other"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Someone");
  git(dir, "config", "user.email", "someone@example.test");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  return { top, dir, remote };
}

const cli = (dir, ...args) => {
  const env = { ...process.env, ...{ GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull } }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(dir, "harness/n8n-dev.mjs"), ...args], { cwd: dir, encoding: "utf8", env });
  const line = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
  return { status: r.status, json: line ? JSON.parse(line) : null, stderr: r.stderr };
};
const BRANCH = "n8n-dev/demo-20261018-0705";
const send = (dir, branch = BRANCH) => cli(dir, "submit", "flows/demo", "--branch", branch, "--message", "Update demo");
const remoteBranches = (remote) => git(remote, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean).sort();
const snapshot = (dir) => [git(dir, "rev-parse", "HEAD"), git(dir, "branch", "--list"), git(dir, "status", "--porcelain=v1"), git(dir, "diff", "--cached", "--name-only")].join("|");
const edit = (dir) => {
  write(path.join(dir, "flows/demo/workflow.json"), workflow("OLALA: down"));
  write(path.join(dir, "flows/demo/tests/01-down.yaml"), testYaml("Down site, reworded"));
  write(path.join(dir, "flows/other/workflow.json"), workflow("someone else's work in progress"));   // must never be sent
};

test("a change goes to a NEW branch as one commit on the shared branch, holding only this workflow's folder", opts, () => {
  const { dir, remote } = makeRepo();
  edit(dir);
  const mainBefore = git(remote, "rev-parse", "main");
  const r = send(dir);
  assert.equal(r.json.state, "sent", r.stderr);
  assert.equal(r.json.branch, BRANCH);
  assert.deepEqual(remoteBranches(remote), ["refs/heads/main", `refs/heads/${BRANCH}`]);
  assert.equal(git(remote, "rev-parse", "main"), mainBefore, "the shared branch must not move");
  assert.equal(git(remote, "rev-parse", `${BRANCH}^`), mainBefore, "one commit on top of the shared branch");
  assert.deepEqual(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", BRANCH).split("\n").sort(), ["flows/demo/tests/01-down.yaml", "flows/demo/workflow.json"]);
  assert.match(git(remote, "show", `${BRANCH}:flows/demo/workflow.json`), /OLALA: down/);
  assert.match(git(remote, "show", `${BRANCH}:flows/other/workflow.json`), /"text": "other"/, "another workflow's unfinished edit must not go");
  assert.match(git(remote, "log", "-1", "--format=%s", BRANCH), /Update demo/);
});

test("nothing local moves: same checkout, no new branch, no staged files, the edits are still there", opts, () => {
  const { dir } = makeRepo();
  edit(dir);
  const before = snapshot(dir);
  assert.equal(send(dir).json.state, "sent");
  assert.equal(snapshot(dir), before);
  assert.match(fs.readFileSync(path.join(dir, "flows/demo/workflow.json"), "utf8"), /OLALA: down/);
});

test("it can never write to the shared branch or anything else: only plain n8n-dev/ branch names are accepted", opts, () => {
  const { dir, remote } = makeRepo();
  edit(dir);
  const before = remoteBranches(remote);
  for (const bad of ["main", "origin/main", "n8n-dev/", "n8n-dev/../main", "n8n-dev/a b", "n8n-dev/a;b", "--force", "refs/heads/main", "n8n-dev/-x", "n8n-dev/" + "a".repeat(90), "n8n-dev/a/b"]) {
    const r = send(dir, bad);
    assert.equal(r.json?.state, "bad-branch", bad);
  }
  assert.deepEqual(remoteBranches(remote), before);
  assert.equal(cli(dir, "submit", "flows/demo", "--branch", BRANCH).json.state, "bad-message");
});

test("with nothing to send it says so and pushes nothing", opts, () => {
  const { dir, remote } = makeRepo();
  assert.equal(send(dir).json.state, "nothing");
  assert.deepEqual(remoteBranches(remote), ["refs/heads/main"]);
});

test("a missing login, a missing remote and an unreachable remote are each reported, and nothing is recorded", opts, () => {
  const none = makeRepo();
  edit(none.dir);
  git(none.dir, "config", "--unset", "user.name");
  assert.equal(send(none.dir).json.state, "no-identity");

  const gone = makeRepo();
  edit(gone.dir);
  fs.rmSync(gone.remote, { recursive: true, force: true });
  const r = send(gone.dir);
  assert.equal(r.json.state, "push-failed");
  assert.equal(fs.existsSync(path.join(gone.dir, ".n8n-dev/submissions.json")), false, "a failed push must not look like a submission");

  const noRemote = makeRepo();
  edit(noRemote.dir);
  git(noRemote.dir, "remote", "remove", "origin");
  assert.equal(send(noRemote.dir).json.state, "no-remote");
});

test("a successful send is recorded, and the same branch name cannot be reused to overwrite it", opts, () => {
  const { dir, remote } = makeRepo();
  edit(dir);
  assert.equal(send(dir).json.state, "sent");
  const records = JSON.parse(fs.readFileSync(path.join(dir, ".n8n-dev/submissions.json"), "utf8"));
  assert.deepEqual(records.map((x) => [x.workflow, x.branch]), [["flows/demo", BRANCH]]);
  const tip = git(remote, "rev-parse", BRANCH);
  write(path.join(dir, "flows/demo/workflow.json"), workflow("a second, different change"));
  const again = send(dir);
  assert.equal(again.json.state, "push-failed", "an existing branch is never overwritten");
  assert.equal(git(remote, "rev-parse", BRANCH), tip);
});

// ---------- facts that depend on the team repository ----------
const facts = (dir, ...more) => cli(dir, "submit-facts", "flows/demo", "--json", ...more);
const advanceRemote = (top, remote, files, message = "someone else") => {         // another person's change reaches the shared branch
  const other = path.join(top, `other-${Math.random().toString(36).slice(2)}`);
  git(top, "clone", "-q", remote, other);
  git(other, "config", "user.name", "Other"); git(other, "config", "user.email", "other@example.test");
  for (const [f, text] of Object.entries(files)) write(path.join(other, f), text);
  git(other, "add", "-A"); git(other, "commit", "-q", "-m", message); git(other, "push", "-q", "origin", "main");
};

test("--fetch brings in the team's latest, and says whether it managed to", opts, () => {
  const { top, dir, remote } = makeRepo();
  advanceRemote(top, remote, { "flows/other/workflow.json": workflow("changed by someone") });
  const stale = facts(dir).json;
  const fresh = facts(dir, "--fetch").json;
  assert.equal(stale.fetched, null);
  assert.equal(fresh.fetched, true);
  assert.notEqual(git(dir, "rev-parse", "origin/main"), git(dir, "rev-parse", "HEAD"), "the local copy of the shared branch moved on");
  fs.rmSync(remote, { recursive: true, force: true });
  const offline = facts(dir, "--fetch").json;
  assert.equal(offline.state, "facts", "an unreachable repository must not stop the comparison");
  assert.equal(offline.fetched, false);
});

test("it notices when someone else changed this workflow since the copy was taken, but not when they changed another", opts, () => {
  const a = makeRepo();
  advanceRemote(a.top, a.remote, { "flows/other/workflow.json": workflow("changed by someone") });
  assert.equal(facts(a.dir, "--fetch").json.sharedChanged, false, "a different workflow does not matter");

  const b = makeRepo();
  advanceRemote(b.top, b.remote, { "flows/demo/workflow.json": workflow("changed by someone else") });
  assert.equal(facts(b.dir).json.sharedChanged, false, "before refreshing it cannot know");
  assert.equal(facts(b.dir, "--fetch").json.sharedChanged, true, "after refreshing it sees that the shared version moved");
});

test("an earlier submission counts as open until it is merged or its branch is removed", opts, () => {
  const { top, dir, remote } = makeRepo();
  edit(dir);
  assert.equal(send(dir).json.state, "sent");
  assert.deepEqual(facts(dir, "--fetch").json.submissions.map((s) => s.open), [true], "waiting for review");

  const merged = makeRepo();                                                // merged: the shared branch now contains it
  edit(merged.dir);
  send(merged.dir);
  git(merged.remote, "update-ref", "refs/heads/main", git(merged.remote, "rev-parse", BRANCH));
  assert.deepEqual(facts(merged.dir, "--fetch").json.submissions.map((s) => s.open), [false]);

  const removed = makeRepo();                                               // rejected: the branch was deleted
  edit(removed.dir);
  send(removed.dir);
  git(removed.remote, "update-ref", "-d", `refs/heads/${BRANCH}`);
  assert.deepEqual(facts(removed.dir, "--fetch").json.submissions.map((s) => s.open), [false]);
  void top; void remote;
});
