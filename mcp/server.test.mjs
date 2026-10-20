// Conformance tests for the real MCP server: it starts `mcp/server.mjs` and speaks the protocol to it over standard
// input and output, in BOTH protocol eras:
//   legacy  the `initialize` handshake (2025-11-25 and earlier)
//   modern  per-request metadata and `server/discover` (2026-07-28)
// Only tools that need no Docker are called. Run with: npm test
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "mcp", "server.mjs");
const TOOLS = ["check_workflow", "draft_test_preview", "draft_test_remove", "draft_test_save", "explain_test_failures", "list_workflows", "pull_apply", "pull_preview", "status", "submit", "submit_preview", "ui_discard", "ui_resume", "ui_start", "ui_stop", "undo_change", "update_tests"];

// A minimal client: one server process, one JSON message per line each way.
class Client {
  constructor(env = {}) {
    this.child = spawn(process.execPath, [SERVER], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.lines = [];        // every line the server wrote to standard output, exactly as written
    this.messages = [];     // those lines, parsed
    this.stderr = "";
    this.waiting = [];
    this.nextId = 1;
    this.exited = new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.lines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      this.messages.push(msg);
      this.waiting = this.waiting.filter((w) => { if (w.matches(msg)) { w.resolve(msg); return false; } return true; });
    });
    this.child.stderr.on("data", (d) => { this.stderr += d; });
  }
  send(msg) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`); }
  waitFor(matches, ms = 20000) {
    const found = this.messages.find(matches);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matching message within ${ms} ms. stderr: ${this.stderr.slice(-500)}`)), ms);
      this.waiting.push({ matches, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }
  request(method, params) {
    const id = this.nextId++;
    this.send({ id, method, params });
    return this.waitFor((m) => m.id === id);
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 8000);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }
}

const MODERN = "2026-07-28";
const meta = (extra = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
  ...extra,
});
const text = (result) => (result.content ?? []).map((c) => c.text).join("\n");

// A reply to a bad call may be a protocol error or a tool error; either is fine, but it must never look like success.
const refused = (reply) => Boolean(reply.error) || reply.result?.isError === true;

// ---------- the older protocol ----------
describe("legacy era (initialize handshake)", () => {
  let c;
  before(async () => { c = new Client(); });
  after(async () => { assert.equal(await c.close(), 0, "the server must exit cleanly when its input closes"); });

  test("initialize negotiates the version, declares tools, and gives the guidance", async () => {
    const r = await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "conformance", version: "1" } });
    assert.equal(r.result.protocolVersion, "2025-11-25");
    assert.ok(r.result.capabilities.tools);
    assert.equal(r.result.serverInfo.name, "n8n-dev");
    assert.match(r.result.instructions, /list_workflows/);
    c.send({ method: "notifications/initialized" });
  });

  test("tools/list returns the seven tools with titles, strict schemas and annotations", async () => {
    const r = await c.request("tools/list", {});
    assert.deepEqual(r.result.tools.map((t) => t.name).sort(), TOOLS);
    for (const t of r.result.tools) {
      assert.ok(t.title, `${t.name} has a title`);
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must reject unknown arguments`);
      assert.equal(t.annotations.openWorldHint, ["submit", "submit_preview"].includes(t.name), t.name);
    }
    assert.deepEqual(r.result.tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort(), ["draft_test_remove", "pull_apply", "ui_discard", "undo_change", "update_tests"]);
  });

  test("tools/call list_workflows returns the real workflows", async () => {
    const r = await c.request("tools/call", { name: "list_workflows", arguments: {} });
    assert.notEqual(r.result.isError, true);
    assert.match(text(r.result), /site-health-alert/);
  });

  test("a path trick in a workflow name is refused", async () => {
    const r = await c.request("tools/call", { name: "check_workflow", arguments: { workflow: "../../etc/passwd" } });
    assert.equal(r.result.isError, true);
    assert.match(text(r.result), /letters, numbers/);
  });

  test("an unknown argument is refused, never silently dropped", async () => {
    const r = await c.request("tools/call", { name: "check_workflow", arguments: { workflow: "site-health-alert", flags: "--evil" } });
    assert.ok(refused(r), JSON.stringify(r));
  });

  test("an unknown tool is refused", async () => {
    assert.ok(refused(await c.request("tools/call", { name: "run_anything", arguments: {} })));
  });

  test("pull_apply without a preview is refused", async () => {
    const r = await c.request("tools/call", { name: "pull_apply", arguments: { workflow: "site-health-alert", code: "123456" } });
    assert.equal(r.result.isError, true);
    assert.match(text(r.result), /not valid/);
  });

  test("ping answers", async () => {
    const r = await c.request("ping", {});
    assert.ok(r.result && !r.error);
  });

  test("everything on standard output is a protocol message, and standard error stays quiet", () => {
    assert.ok(c.lines.length >= 6);
    for (const line of c.lines) {
      const msg = JSON.parse(line);
      assert.equal(msg.jsonrpc, "2.0", line);
    }
    assert.equal(c.stderr.trim(), "", `unexpected output on standard error: ${c.stderr}`);
  });
});

test("an older client asking for an older version gets a version the server supports", async () => {
  const c = new Client();
  const r = await c.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old", version: "1" } });
  assert.match(r.result.protocolVersion, /^20\d\d-\d\d-\d\d$/);
  assert.ok(r.result.capabilities.tools);
  await c.close();
});

// ---------- the newer protocol ----------
describe("modern era (per-request metadata, no handshake)", () => {
  let c;
  before(async () => { c = new Client(); });
  after(async () => { assert.equal(await c.close(), 0); });

  test("server/discover reports the version, the tools capability, the identity and the guidance", async () => {
    const r = await c.request("server/discover", { _meta: meta() });
    assert.ok(r.result.supportedVersions.includes(MODERN), JSON.stringify(r));
    assert.ok(r.result.capabilities.tools);
    assert.equal(r.result._meta["io.modelcontextprotocol/serverInfo"].name, "n8n-dev");
    assert.match(r.result.instructions, /list_workflows/);
    assert.equal(r.result.resultType, "complete");
  });

  test("tools/list works with no handshake", async () => {
    const r = await c.request("tools/list", { _meta: meta() });
    assert.deepEqual(r.result.tools.map((t) => t.name).sort(), TOOLS);
    assert.equal(r.result.resultType, "complete");
  });

  test("tools/call list_workflows returns the real workflows", async () => {
    const r = await c.request("tools/call", { name: "list_workflows", arguments: {}, _meta: meta() });
    assert.notEqual(r.result.isError, true);
    assert.match(text(r.result), /site-health-alert/);
    assert.equal(r.result.resultType, "complete");
  });

  test("the same guards apply: a path trick and an unknown argument are refused", async () => {
    const trick = await c.request("tools/call", { name: "check_workflow", arguments: { workflow: "..\\..\\secrets" }, _meta: meta() });
    assert.equal(trick.result.isError, true);
    const extra = await c.request("tools/call", { name: "check_workflow", arguments: { workflow: "site-health-alert", flags: "--evil" }, _meta: meta() });
    assert.ok(refused(extra), JSON.stringify(extra));
  });

  // The library checks the version on a connection's FIRST request, then pins the connection (observed: later requests
  // claiming an unsupported version are served normally, tool calls included). So this runs on a fresh connection.
  test("an unsupported protocol version on a new connection is answered with the versions the server supports", async () => {
    for (const method of ["tools/list", "tools/call"]) {
      const fresh = new Client();
      const params = method === "tools/call" ? { name: "list_workflows", arguments: {} } : {};
      const r = await fresh.request(method, { ...params, _meta: meta({ "io.modelcontextprotocol/protocolVersion": "1900-01-01" }) });
      assert.equal(r.error?.code, -32022, `${method}: ${JSON.stringify(r)}`);
      assert.ok(r.error.data.supported.includes(MODERN));
      await fresh.close();
    }
  });

  // Known gap, reported with this change: the spec says every request is checked, but the library serves later
  // requests on an already-open connection whatever version they claim. Harmless here (nothing depends on the
  // claimed version and every request on a stdio connection comes from the one client that started it).
  test.todo("an unsupported version on a LATER request of an open connection is rejected too");

  test("a modern request missing the required capabilities is refused as invalid", async () => {
    const m = meta();
    delete m["io.modelcontextprotocol/clientCapabilities"];
    const r = await c.request("tools/list", { _meta: m });
    assert.equal(r.error.code, -32602, JSON.stringify(r));
  });

  test("everything on standard output is a protocol message, and standard error stays quiet", () => {
    for (const line of c.lines) assert.equal(JSON.parse(line).jsonrpc, "2.0", line);
    assert.equal(c.stderr.trim(), "", `unexpected output on standard error: ${c.stderr}`);
  });
});

// ---------- start-up and shutdown ----------
test("a server pointed at a folder that is not an n8n-dev repository refuses to start, with a clear message", async () => {
  const c = new Client({ N8N_DEV_ROOT: path.join(ROOT, "workflows") });
  const code = await c.exited;
  assert.equal(code, 1);
  assert.match(c.stderr, /not an n8n-dev repository/);
  assert.equal(c.lines.length, 0, "nothing may be written to standard output");
});

test("closing standard input stops the server promptly with a clean exit", async () => {
  const c = new Client();
  await new Promise((resolve) => setTimeout(resolve, 700));        // let it finish starting up
  const started = Date.now();
  assert.equal(await c.close(), 0);
  assert.ok(Date.now() - started < 8000);
});
