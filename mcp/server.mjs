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
  "You help someone change n8n workflows safely, without touching the live n8n. Nothing here contacts a live n8n or any outside service; the only thing that ever leaves this computer is a change the person has agreed to send, and it goes to the team's own repository for review.",
  "The person is not technical. Talk in plain words: steps, tests, checks, 'the safe test editor'. Never mention commands, file or folder names, flags, Docker internals or other technical terms. Never ask the person to run a command, edit a file or open a terminal: you do everything yourself through these tools. If a tool's reply has a part marked as for you, the assistant, do not read that part out.",
  "Start with list_workflows. Use check_workflow to run the safety checks and tests, and pass on the result in plain words.",
  "When the person wants a workflow to do something new, start by asking what should happen, in their words, before touching anything. Write that as a test with draft_test_preview, using only what they said (never what the workflow does today), and show it to them in plain when/then sentences. Stop and wait. Only when they tell you in their own words to add it, call draft_test_save. Tell them plainly that the new test will fail until the workflow does what it says: that is expected. Then offer to open the test editor. Never write a test the person has not seen and agreed to.",
  "Use ui_start so the person can see what a workflow does and try a change in a safe test editor that cannot reach the internet or their files. Give them the address and the sign-in it returns, then stop and wait for them to write back: never call another tool in the same turn. Call ui_stop only when the person tells you in their own words that they are finished, and pass those words to it. Never close the editor on your own.",
  "If a test editor, or changes saved from one, are left over from earlier (status tells you, and ui_start will refuse and say so), tell the person plainly what was found and how old it is, and let them choose: carry on (ui_resume), save and close (ui_stop), look at the saved changes (pull_preview), or throw it away (ui_discard, only with their own words). Never choose for them, and never throw anything away on your own.",
  "Use pull_preview to show what they changed, as the exact before-and-after text. Ask them to confirm before you call pull_apply with the code. Never apply anything the person has not seen and agreed to. If a check fails after a change was applied, say plainly which test failed and why, and call explain_test_failures. Never update a test the person has not confirmed they meant to change, and never touch tests it cannot explain: say they need someone who knows the tests, and offer undo_change. Never undo unless the person agrees.",
  "When the person says a change is finished and wants it reviewed, call submit_preview and tell them in plain words what would be sent and anything that stops it. If it says the workflow changed without a test, ask them for a one-sentence reason and pass it as reason; never invent a reason yourself. Then STOP and wait for the person to reply. Only when they tell you in their own words to send it, call submit with the code and their words; never send on your own, never in the same turn as the preview. It sends the change to the team for review and gives you a link: pass it on, and say it is not live until a reviewer approves it.",
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
