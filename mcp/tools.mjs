// The tools an assistant can call. This file does no I/O of its own: it is handed `fsx` (read-only file access)
// and `runCli` (runs the n8n-dev command line with a fixed argument list), so every rule below can be tested with
// fakes, and a refused call can be proven never to have reached the command line.
import { resolveWorkflow, pickPort, truncate, hashOf, strictArgs, isValidWorkflowName } from "./guards.mjs";
import { replyForCheck, replyForStart, replyForStop, replyForStopRefused, replyForPreview, replyForApply, replyForUndo, replyForStatus } from "./replies.mjs";

const MINUTE = 60_000;
export const MIN_OPEN_MS = 30_000;       // an editor the person has only just been given cannot be closed yet
const MAX_WORDS = 200;
const CLI_ENV = { N8N_CMD: "./scripts/n8n-docker.sh" };      // how `check` reaches the offline n8n
const MANIFEST = ".n8n-dev/ui-manifest.json";
const EXPORT_DIR = ".n8n-dev/ui-export";

export function createTools({ fsx, runCli, codes, now = Date.now }) {
  // What the tools remember between calls: the latest check of each workflow, and which one is open (and since when).
  const state = { checks: {}, chamber: null, openedAt: null };
  const result = (text, isError = false) => ({ text: truncate(text), isError });

  const workflowsDir = () => {
    try { return JSON.parse(fsx.readText("config/readiness.json")).workflowsDir || "workflows"; } catch { return "workflows"; }
  };
  const pick = (name) => resolveWorkflow({ workflowsDir: workflowsDir(), name, exists: (p) => fsx.exists(p) });

  const testFiles = (dir) => (fsx.exists(`${dir}/tests`)
    ? fsx.listDir(`${dir}/tests`).filter((e) => e.isFile && /\.ya?ml$/.test(e.name)).map((e) => e.name).sort() : []);
  const exportFiles = () => (fsx.exists(EXPORT_DIR)
    ? fsx.listDir(EXPORT_DIR).filter((e) => e.isFile && e.name.endsWith(".json")).map((e) => e.name).sort() : []);

  // A fingerprint of a workflow and its tests. A check only counts for content that has not changed since.
  const workflowHash = (dir) => hashOf({
    workflow: fsx.readText(`${dir}/workflow.json`),
    tests: testFiles(dir).map((f) => [f, fsx.readText(`${dir}/tests/${f}`)]),
  });
  // A fingerprint of everything a pull would act on. A preview only counts while none of it has changed.
  const pullHash = (dir) => hashOf({
    workflow: fsx.readText(`${dir}/workflow.json`),
    manifest: fsx.exists(MANIFEST) ? fsx.readText(MANIFEST) : null,
    exports: exportFiles().map((f) => [f, fsx.readText(`${EXPORT_DIR}/${f}`)]),
  });

  // Runs the command line and turns its answer into a tool result.
  const run = async (args, { timeoutMs = 2 * MINUTE, okStatuses = [0] } = {}) => {
    const r = await runCli(args, { timeoutMs, env: CLI_ENV });
    return { ...r, ok: okStatuses.includes(r.status) };
  };
  // The command line prints one JSON object as its last line when given --json. Anything before it is ignored.
  const lastJson = (r) => {
    const lines = String(r.stdout ?? r.out ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
    for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* try the line before */ } }
    return null;
  };
  const plain = (reply) => result(reply.text, reply.isError);
  const unclear = "I couldn't do that just now. Make sure Docker Desktop is open and running, then ask me to try again.";

  const tools = [
    {
      name: "list_workflows",
      title: "List workflows",
      description: "List the n8n workflows in this repository, with how many tests each has. Use the names it returns with the other tools.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, {});
        if (a.error) return result(a.error, true);
        const base = workflowsDir();
        const names = fsx.exists(base)
          ? fsx.listDir(base).filter((e) => e.isDirectory && isValidWorkflowName(e.name) && fsx.exists(`${base}/${e.name}/workflow.json`))
              .map((e) => e.name).sort()
          : [];
        if (!names.length) return result(`There are no workflows in ${base}/ yet.`);
        return result(names.map((n) => {
          const count = testFiles(`${base}/${n}`).length;
          return `- ${n} (${count} test${count === 1 ? "" : "s"})`;
        }).join("\n"));
      },
    },
    {
      name: "check_workflow",
      title: "Check a workflow",
      description: "Run the safety checks and the tests for one workflow and return the report. Nothing real is contacted: every outside service is faked. It can take a minute or two, and longer the very first time.",
      inputSchema: { type: "object", properties: { workflow: { type: "string", description: "A name from list_workflows" } }, required: ["workflow"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const hash = workflowHash(w.dir);
        const r = await run(["check", w.dir, "--json"], { timeoutMs: 10 * MINUTE, okStatuses: [0, 1] });
        const report = r.ok ? lastJson(r) : null;
        if (!report) return plain(replyForCheck(a.value.workflow, null, r.out));
        state.checks[a.value.workflow] = { passed: report.allPass === true, hash };
        return plain(replyForCheck(a.value.workflow, report));
      },
    },
    {
      name: "status",
      title: "Check for an open editor",
      description: "Report whether a sealed editor from an earlier run is still open.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, {});
        if (a.error) return result(a.error, true);
        const r = await run(["status"], { okStatuses: [0, 1] });
        return plain(replyForStatus(r.ok ? r.status : 2, r.out));
      },
    },
    {
      name: "ui_start",
      title: "Open the sealed editor",
      description: "Open a sealed local n8n editor with the workflow's tests loaded, so the person can see what the workflow does and try changes. It cannot reach the internet or the person's files. Returns an address and a throwaway login to give to the person. After it succeeds, give the person the address and sign-in, then STOP and wait: do not call any other tool until the person writes back to you. It stays open until the person says they are finished.",
      inputSchema: { type: "object", properties: { workflow: { type: "string", description: "A name from list_workflows" }, port: { type: "integer", description: "Optional, 1024 to 65535; the default is 5678" } }, required: ["workflow"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, port: { type: "any" } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const p = pickPort(a.value.port);
        if (p.error) return result(p.error, true);
        const cli = ["ui", w.dir, "--detach", "--json"];
        if (a.value.port !== undefined) cli.push("--port", String(p.port));
        const r = await run(cli, { timeoutMs: 5 * MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r) ?? { state: "failed", details: r.out };
        if (j.state === "started") { state.chamber = a.value.workflow; state.openedAt = now(); }
        return plain(replyForStart(j));
      },
    },
    {
      name: "ui_stop",
      title: "Close the editor and save edits",
      description: "Save the person's edits from the safe test editor and close it. ONLY call this after the person has written to you, in their own words, that they have finished. Never call it in the same step as ui_start, and never because you think the job is done: closing the editor ends their session. Put their words in theirWords. It returns what they changed.",
      inputSchema: { type: "object", properties: { theirWords: { type: "string", description: "The person's own words saying they are finished, copied exactly (for example: I'm done)" } }, required: ["theirWords"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { theirWords: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const words = a.value.theirWords.trim();
        if (!words || words.length > MAX_WORDS) return plain(replyForStopRefused("no-words"));
        if (state.openedAt !== null && now() - state.openedAt < MIN_OPEN_MS) return plain(replyForStopRefused("too-soon"));
        const r = await run(["ui-stop", "--json"], { timeoutMs: 3 * MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state !== "no-session") { state.chamber = null; state.openedAt = null; }
        return plain(replyForStop(j));
      },
    },
    {
      name: "pull_preview",
      title: "Preview changes to apply",
      description: "Show which of the person's edits would be applied to the workflow file. It changes nothing. If there is something to apply it returns a one-time code. Show the person the changes and ask them to confirm before you call pull_apply with that code.",
      inputSchema: { type: "object", properties: { workflow: { type: "string", description: "A name from list_workflows" } }, required: ["workflow"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const r = await run(["pull", w.dir, "--json"], { okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        // A code is issued only when there really is something to apply and nothing blocks it.
        const code = j.state === "ready" ? codes.issue(`pull:${a.value.workflow}:${pullHash(w.dir)}`) : undefined;
        return plain(replyForPreview(j, code));
      },
    },
    {
      name: "pull_apply",
      title: "Apply the previewed changes",
      description: "Apply the previewed edits to the workflow file. It needs the code from pull_preview, and only works if nothing has changed since the preview. Call it only after the person has seen the changes and agreed.",
      inputSchema: { type: "object", properties: { workflow: { type: "string" }, code: { type: "string", description: "The code from pull_preview" } }, required: ["workflow", "code"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, code: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const redeemed = codes.redeem(a.value.code, `pull:${a.value.workflow}:${pullHash(w.dir)}`);
        if (!redeemed.ok) return result(redeemed.reason, true);
        const r = await run(["pull", w.dir, "--apply", "--json"], { okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "applied") delete state.checks[a.value.workflow];   // the content changed, so any earlier check no longer counts
        return plain(replyForApply(j));
      },
    },
    {
      name: "undo_change",
      title: "Undo the last applied change",
      description: "Put the workflow back exactly as it was before the last change was applied. ONLY call this when the person has asked, in their own words, to undo or go back (put their words in theirWords), or after you have told them a change broke the checks and they agreed to undo it. It only works if nobody has changed the workflow since, and it goes back one step.",
      inputSchema: { type: "object", properties: { theirWords: { type: "string", description: "The person's own words asking to undo, copied exactly" } }, required: ["theirWords"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { theirWords: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const words = a.value.theirWords.trim();
        if (!words || words.length > MAX_WORDS) return plain(replyForUndo({ state: "no-words" }));
        const r = await run(["undo", "--json"], { okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "restored") for (const k of Object.keys(state.checks)) delete state.checks[k];   // the content changed back
        return plain(replyForUndo(j));
      },
    },
  ];

  return { tools, state, workflowHash };
}
