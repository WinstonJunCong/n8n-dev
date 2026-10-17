// The MCP server: `node mcp/server.mjs`. An AI assistant starts it and talks to it over standard input and output.
//
// It uses the official library only for the protocol (the message format and the two protocol eras: the older
// `initialize` handshake and the newer per-request one). Everything that decides what is allowed lives in
// guards.mjs, tools.mjs and effects.mjs.
//
// Standard output belongs to the protocol. Anything else printed there would corrupt the conversation, so the guard
// below must stay the FIRST import: it sends console.log, info and debug to standard error before anything else loads.
import "./stdout-guard.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { makeFs, makeRunner } from "./effects.mjs";
import { makeCodeStore } from "./guards.mjs";
import { createTools } from "./tools.mjs";
import { registerAll } from "./register.mjs";

const SERVER_INFO = { name: "n8n-dev", version: "0.1.0" };

// Guidance for the assistant, delivered when it connects.
const INSTRUCTIONS = [
  "You help someone change n8n workflows safely, without touching the live n8n. Nothing here contacts a live n8n or any outside service.",
  "The person is not technical. Talk in plain words: steps, tests, checks, 'the safe test editor'. Never mention commands, file or folder names, flags, Docker internals or other technical terms. Never ask the person to run a command, edit a file or open a terminal: you do everything yourself through these tools. If a tool's reply has a part marked as for you, the assistant, do not read that part out.",
  "Start with list_workflows. Use check_workflow to run the safety checks and tests, and pass on the result in plain words.",
  "Use ui_start so the person can see what a workflow does and try a change in a safe test editor that cannot reach the internet or their files. Give them the address and the sign-in it returns, then stop and wait for them to write back: never call another tool in the same turn. Call ui_stop only when the person tells you in their own words that they are finished, and pass those words to it. Never close the editor on your own.",
  "Use pull_preview to show what they changed, as the exact before-and-after text. Ask them to confirm before you call pull_apply with the code. Never apply anything the person has not seen and agreed to. If a check fails after a change was applied, say plainly which test failed and why, and call explain_test_failures. Never update a test the person has not confirmed they meant to change, and never touch tests it cannot explain: say they need someone who knows the tests, and offer undo_change. Never undo unless the person agrees.",
].join("\n\n");

// The repository this server works on: the one it lives in, or the one named by N8N_DEV_ROOT.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.N8N_DEV_ROOT || path.join(here, ".."));
const fsx = makeFs(root);
if (!fsx.exists("harness/n8n-dev.mjs")) {
  console.error(`n8n-dev MCP server: ${root} is not an n8n-dev repository (harness/n8n-dev.mjs is missing).`);
  process.exit(1);
}

// One set of tools for the whole process, so the one-time codes and remembered checks are shared however many
// server instances the library asks for.
const { tools } = createTools({ fsx, runCli: makeRunner({ root }), codes: makeCodeStore() });

const connection = serveStdio(() => {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  registerAll(server, tools);
  return server;
});

// A client closing our standard input is the normal way to stop; these cover being asked to quit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { connection.close().finally(() => process.exit(0)); });
}
