// Turns our tools into MCP tool registrations. Kept apart from server.mjs so it can be tested with a fake server:
// it imports only zod, never the MCP library, and does no I/O.
import * as z from "zod/v4";

// Our tools describe their inputs as a small JSON Schema. The library wants a Zod schema. Only the shapes we use
// are supported, and anything else throws at start-up, so a new kind of input can never slip through unchecked.
// The object is STRICT: an unknown argument is rejected before our own checks even run.
export function toZod(schema) {
  const required = new Set(schema.required ?? []);
  const shape = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let field;
    if (prop.type === "string") field = z.string();
    else if (prop.type === "integer") field = z.number().int();
    else throw new Error(`Unsupported input type "${prop.type}" for "${key}"`);
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.strictObject(shape);
}

// Calls a tool and shapes its answer for the protocol. If the tool ever throws, the person gets a plain message and
// the details go to stderr, never into the reply.
export function wrapHandler(tool, log = (...a) => console.error(...a)) {
  return async (args) => {
    try {
      const r = await tool.handler(args);
      return { content: [{ type: "text", text: String(r.text) }], isError: Boolean(r.isError) };
    } catch (e) {
      log(`[n8n-dev mcp] ${tool.name} failed:`, e);
      return {
        content: [{ type: "text", text: "The tool failed unexpectedly. Check status before trying again; nothing was sent to GitHub." }],
        isError: true,
      };
    }
  };
}

export function registerAll(server, tools, log) {
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: toZod(tool.inputSchema),
      annotations: tool.annotations,
    }, wrapHandler(tool, log));
  }
}
