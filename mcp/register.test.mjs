// Unit tests for mcp/register.mjs, using a fake server. No protocol, no processes. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";
import { toZod, wrapHandler, registerAll } from "./register.mjs";
import { createTools } from "./tools.mjs";
import { makeCodeStore } from "./guards.mjs";

// ---------- toZod ----------
const WORKFLOW = { type: "object", properties: { workflow: { type: "string", description: "A name" } }, required: ["workflow"], additionalProperties: false };
const WITH_PORT = { type: "object", properties: { workflow: { type: "string" }, port: { type: "integer" } }, required: ["workflow"], additionalProperties: false };

test("toZod accepts valid input and describes fields", () => {
  const s = toZod(WORKFLOW);
  assert.deepEqual(s.parse({ workflow: "site-health-alert" }), { workflow: "site-health-alert" });
  assert.equal(z.toJSONSchema(s).properties.workflow.description, "A name");
});

test("toZod is strict: unknown keys are rejected, not silently dropped", () => {
  const s = toZod(WORKFLOW);
  for (const bad of [{ workflow: "a", flags: "--evil" }, { workflow: "a", __proto__x: 1 }, { workflow: "a", constructor: "x" }]) {
    assert.equal(s.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(z.toJSONSchema(s).additionalProperties, false);
});

test("toZod rejects missing required values and wrong types", () => {
  const s = toZod(WITH_PORT);
  assert.equal(s.safeParse({}).success, false);
  assert.equal(s.safeParse({ workflow: 5 }).success, false);
  assert.equal(s.safeParse({ workflow: "a", port: "8080" }).success, false);
  assert.equal(s.safeParse({ workflow: "a", port: 80.5 }).success, false);
  assert.equal(s.safeParse({ workflow: "a", port: 8080 }).success, true);
  assert.equal(s.safeParse({ workflow: "a" }).success, true);          // port is optional
});

test("toZod makes an empty schema that accepts only an empty object", () => {
  const s = toZod({ type: "object", properties: {}, additionalProperties: false });
  assert.equal(s.safeParse({}).success, true);
  assert.equal(s.safeParse({ x: 1 }).success, false);
});

test("toZod refuses input types it does not know, so nothing is ever left unchecked", () => {
  assert.throws(() => toZod({ type: "object", properties: { x: { type: "array" } } }), /Unsupported input type "array"/);
  assert.throws(() => toZod({ type: "object", properties: { x: { type: "object" } } }), /Unsupported input type/);
});

// ---------- wrapHandler ----------
test("wrapHandler turns a tool result into protocol content", async () => {
  const run = wrapHandler({ name: "t", handler: async () => ({ text: "hello", isError: false }) });
  assert.deepEqual(await run({}), { content: [{ type: "text", text: "hello" }], isError: false });
  const bad = wrapHandler({ name: "t", handler: async () => ({ text: "no", isError: true }) });
  assert.equal((await bad({})).isError, true);
});

test("wrapHandler passes the arguments through unchanged", async () => {
  let seen;
  await wrapHandler({ name: "t", handler: async (a) => (seen = a, { text: "", isError: false }) })({ workflow: "x" });
  assert.deepEqual(seen, { workflow: "x" });
});

test("a tool that throws gives a plain message, and the details go only to the log", async () => {
  const logged = [];
  const run = wrapHandler({ name: "boom", handler: async () => { throw new Error("secret path C:\\Users\\x\\file"); } }, (...a) => logged.push(a));
  const r = await run({});
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.content[0].text, /secret path|Users|Error/);
  assert.match(r.content[0].text, /failed unexpectedly/);
  assert.match(String(logged[0][0]), /boom failed/);
});

test("wrapHandler copes with a tool that returns no text", async () => {
  const r = await wrapHandler({ name: "t", handler: async () => ({ isError: false }) })({});
  assert.equal(r.content[0].type, "text");
});

// ---------- registerAll ----------
const realTools = () => createTools({
  fsx: { exists: () => false, readText: () => "", listDir: () => [] },
  runCli: async () => ({ status: 0, out: "" }),
  codes: makeCodeStore(),
}).tools;

test("registerAll registers every tool with its title, description, strict schema and annotations", () => {
  const registered = [];
  registerAll({ registerTool: (name, config, cb) => registered.push({ name, config, cb }) }, realTools());
  assert.equal(registered.length, 17);
  for (const r of registered) {
    assert.ok(r.config.title && r.config.title.length > 3, `${r.name} needs a title`);
    assert.ok(r.config.description.length > 30, r.name);
    assert.equal(typeof r.cb, "function");
    assert.equal(z.toJSONSchema(r.config.inputSchema).additionalProperties, false, `${r.name} must reject unknown arguments`);
    assert.equal(r.config.annotations.openWorldHint, ["submit", "submit_preview"].includes(r.name), r.name);
  }
});

test("registering a broken tool fails at start-up instead of running unchecked", () => {
  const tool = { name: "x", title: "X", description: "d".repeat(40), inputSchema: { type: "object", properties: { a: { type: "array" } } }, annotations: {}, handler: async () => ({}) };
  assert.throws(() => registerAll({ registerTool() {} }, [tool]), /Unsupported input type/);
});
