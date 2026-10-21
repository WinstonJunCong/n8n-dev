// The tools an assistant can call. This file does no I/O of its own: it is handed `fsx` (read-only file access)
// and `runCli` (runs the n8n-dev command line with a fixed argument list), so every rule below can be tested with
// fakes, and a refused call can be proven never to have reached the command line.
import { resolveWorkflow, pickPort, truncate, hashOf, strictArgs, isValidWorkflowName } from "./guards.mjs";
import { decideSubmit, branchName, commitMessage, compareUrl } from "./submit.mjs";
import { replyForCheck, replyForStart, replyForStop, replyForStopRefused, replyForPreview, replyForApply, replyForUndo, replyForTestFix, replyForTestUpdate, replyForSubmitPreview, replyForSubmitRefused, replyForSend, replyForStatus, replyForSession, replyForStartRefused, replyForResume, replyForDiscard, replyForDraftPreview, replyForDraftRefused, replyForDraftSaved, replyForDraftRemoved, replyForStaleCode, replyForDescribe } from "./replies.mjs";

const MINUTE = 60_000;
export const MIN_OPEN_MS = 30_000;       // an editor the person has only just been given cannot be closed yet
export const MIN_CONFIRM_MS = 10_000;     // the person must have had time to read a preview before it can be sent
const MAX_WORDS = 200;
const MAX_REQUEST_WORDS = 500;     // the person's description of what should happen
const CLI_ENV = { N8N_CMD: "./scripts/n8n-docker.sh" };      // how `check` reaches the offline n8n
const MANIFEST = ".n8n-dev/ui-manifest.json";
const EXPORT_DIR = ".n8n-dev/ui-export";
const LAST_APPLY = ".n8n-dev/last-apply.json";

export function createTools({ fsx, runCli, codes, now = Date.now }) {
  // What the tools remember between calls: the latest check of each workflow, and which one is open (and since when).
  const state = { checks: {}, chamber: null, openedAt: null, previewedAt: {}, drafts: {} };
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

  // A fingerprint of everything a test update would act on: the workflow, its tests and the record of the last apply.
  const testsHash = (dir) => hashOf({ hash: workflowHash(dir), applied: fsx.exists(LAST_APPLY) ? fsx.readText(LAST_APPLY) : null });

  // Everything submit_preview and submit both need to know, gathered fresh each time: whether a test editor is open, what
  // differs from the shared version (after refreshing from the team's repository), and the decision that follows.
  const gatherSubmit = async (workflow, dir, reason) => {
    const s = await run(["status"], { okStatuses: [0, 1] });
    const editorOpen = s.ok ? s.status === 1 : "unknown";
    const f = await run(["submit-facts", dir, "--fetch", "--json"], { timeoutMs: 2 * MINUTE, okStatuses: [0, 2] });
    const facts = lastJson(f) ?? { state: "no-facts" };
    const content = workflowHash(dir);
    const decision = decideSubmit({ facts, check: state.checks[workflow], currentHash: content, editorOpen, reason, now: new Date(now()) });
    const subject = `submit:${workflow}:${hashOf({ content, files: facts.files, reason: decision.noTestReason ?? null })}`;
    return { facts, decision, subject };
  };

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
      description: "Report whether a test editor, or changes saved from one, are left over from earlier, how old they are, and what the person can do about it. It changes nothing. If something is there, tell the person in plain words and let them choose: carry on (ui_resume), save and close (ui_stop), or throw it away (ui_discard).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, {});
        if (a.error) return result(a.error, true);
        const s = await run(["session", "--json"], { okStatuses: [0] });
        const j = lastJson(s);
        if (j && j.kind) return plain(replyForSession(j));
        const r = await run(["status"], { okStatuses: [0, 1] });                // the session report was unreadable: fall back to the plain yes/no
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
        if (j.state === "already-running" || j.state === "pending-edits") { const offer = replyForStartRefused(j); if (offer) return plain(offer); }
        return plain(replyForStart(j));
      },
    },
    {
      name: "ui_resume",
      title: "Bring back an earlier editor",
      description: "Bring back a test editor that was stopped (a restart, a crash) or is still running from earlier, with the person's changes still in it. Only when the person chose to carry on. It never creates or deletes anything. It refuses if the workflow changed since that editor was opened. Give the person the address and sign-in, then STOP and wait for them to write back.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, {});
        if (a.error) return result(a.error, true);
        const r = await run(["ui-resume", "--json"], { timeoutMs: 5 * MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r) ?? { state: "failed", details: r.out };
        if (j.state === "resumed") { state.chamber = j.workflow ? j.workflow.split("/").pop() : "editor"; state.openedAt = now(); }
        return plain(replyForResume(j));
      },
    },
    {
      name: "ui_discard",
      title: "Throw away an earlier editor",
      description: "Throw away a test editor left over from earlier, whatever is in it, and any changes saved from it that were never applied. It never touches the workflow, its tests, or what undo needs. ONLY call this when the person has told you, in their own words, that they want it thrown away (put their words in theirWords). It cannot be undone.",
      inputSchema: { type: "object", properties: { theirWords: { type: "string", description: "The person's own words saying to throw it away, copied exactly" } }, required: ["theirWords"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { theirWords: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const words = a.value.theirWords.trim();
        if (!words || words.length > MAX_WORDS) return plain(replyForDiscard({ state: "no-words" }));
        const r = await run(["ui-discard", "--json"], { timeoutMs: 3 * MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "discarded") { state.chamber = null; state.openedAt = null; }
        return plain(replyForDiscard(j));
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
        if (!redeemed.ok) return plain(replyForStaleCode("changes", "pull_preview", redeemed.reason));
        const r = await run(["pull", w.dir, "--apply", "--json"], { okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "applied") delete state.checks[a.value.workflow];   // the content changed, so any earlier check no longer counts
        return plain(replyForApply(j));
      },
    },
    {
      name: "explain_test_failures",
      title: "Explain tests broken by a change",
      description: "After a change was applied, work out which tests now fail only because they still expect the old wording, and say so in plain words. It changes nothing and can take a minute or two. If it finds tests that can be updated it returns a one-time code. Tell the person exactly which wording the tests expect and ask them to confirm they changed it on purpose before you call update_tests with that code. Tests it cannot explain are never updated: say they need someone who knows the tests, and offer undo_change.",
      inputSchema: { type: "object", properties: { workflow: { type: "string", description: "A name from list_workflows" } }, required: ["workflow"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const r = await run(["tests-fix", w.dir, "--json"], { timeoutMs: 10 * MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return plain(replyForTestFix({ state: "failed" }));
        const code = j.state === "ready" ? codes.issue(`tests:${a.value.workflow}:${testsHash(w.dir)}`) : undefined;
        return plain(replyForTestFix(j, code));
      },
    },
    {
      name: "update_tests",
      title: "Update the tests a change broke",
      description: "Update only the tests that explain_test_failures found, to match the new wording. It needs the code from explain_test_failures, and only works if nothing has changed since. Call it only after the person has seen exactly what the tests will expect and confirmed they changed the wording on purpose.",
      inputSchema: { type: "object", properties: { workflow: { type: "string" }, code: { type: "string", description: "The code from explain_test_failures" } }, required: ["workflow", "code"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, code: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const redeemed = codes.redeem(a.value.code, `tests:${a.value.workflow}:${testsHash(w.dir)}`);
        if (!redeemed.ok) return plain(replyForStaleCode("test updates", "explain_test_failures", redeemed.reason));
        const r = await run(["tests-fix", w.dir, "--apply", "--json"], { timeoutMs: 10 * MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "applied") delete state.checks[a.value.workflow];
        return plain(replyForTestUpdate(j));
      },
    },
    {
      name: "describe_workflow",
      title: "See how a workflow works",
      description: "Show how one workflow works: its steps in the order a run reaches them, which of them talk to outside services (and so need a pretend answer in a test), the field names and example values the existing tests use for the starting event and for each pretend answer, and the existing tests in the form a new test is written in. It changes nothing. Call it BEFORE writing a test with draft_test_preview, and copy step names and field names from it exactly: never invent a field name. It tells the person, in plain words, what the workflow does and which tests it has.",
      inputSchema: { type: "object", properties: { workflow: { type: "string", description: "A name from list_workflows" } }, required: ["workflow"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const r = await run(["describe", w.dir], { timeoutMs: MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        return plain(replyForDescribe(j));
      },
    },
    {
      name: "draft_test_preview",
      title: "Preview a test written from the person's words",
      description: "Turn what the person says should happen into a test, and show it to them in plain when/then sentences before anything is written. First call describe_workflow and copy the step names and field names from it. It writes nothing. Put the person's own words, copied exactly, in theirWords: the test keeps them as a note so a reviewer sees what was asked for. Write the test only from what the person said, never from what the workflow currently does. spec is a JSON string: {\"name\":\"short name\",\"when\":{\"trigger\":{...the starting event's data...},\"services\":{\"<a step that talks to an outside service>\":[{...its pretend answer...}]}},\"then\":[{\"step\":\"S\",\"runs\":1},{\"step\":\"S\",\"doesNotRun\":true},{\"step\":\"S\",\"side\":\"input or output\",\"field\":\"a.b\",\"is or contains or isNot\":\"value\"},{\"endsAt\":\"S\"}]}. Step names must be exactly those in the workflow. If the request needs more than one test, give a JSON list of such objects (up to 6) in ONE preview: the person confirms them all with one yes, and they are added all together or not at all. Never run previews in parallel: a newer preview replaces an older one. It refuses with the reasons if the description does not fit. If it is ready it returns a one-time code. After showing the person the result, STOP and wait for them to reply before calling draft_test_save.",
      inputSchema: { type: "object", properties: { workflow: { type: "string", description: "A name from list_workflows" }, spec: { type: "string", description: "The test as a JSON string (see the tool description)" }, theirWords: { type: "string", description: "The person's own words describing what should happen, copied exactly" } }, required: ["workflow", "spec", "theirWords"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, spec: { type: "string", required: true }, theirWords: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const words = a.value.theirWords.trim();
        if (!words || words.length > MAX_REQUEST_WORDS) return plain(replyForDraftPreview({ state: "invalid", errors: [{ code: "no-words" }] }));
        const r = await run(["test-add", w.dir, "--spec", a.value.spec, "--words", words], { timeoutMs: MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state !== "ready") return plain(replyForDraftPreview(j));
        const code = codes.issue(`draft:${a.value.workflow}:${hashOf({ content: workflowHash(w.dir), spec: a.value.spec, words })}`);
        for (const old of Object.keys(state.drafts)) if (state.drafts[old].workflow === a.value.workflow) delete state.drafts[old];     // a new preview replaces the old one
        state.drafts[code] = { workflow: a.value.workflow, spec: a.value.spec, words, shownAt: now() };
        return plain(replyForDraftPreview(j, code, words));
      },
    },
    {
      name: "draft_test_save",
      title: "Add the previewed test",
      description: "Add the test that draft_test_preview showed. ONLY call this after the person has seen the test and told you in their own words to add it (put their words in theirWords). Never in the same step as draft_test_preview. It needs the code from the preview, and only works if nothing changed since. It adds one new test and never changes an existing one. The new test will fail until the workflow does what it says: that is expected.",
      inputSchema: { type: "object", properties: { workflow: { type: "string" }, code: { type: "string", description: "The code from draft_test_preview" }, theirWords: { type: "string", description: "The person's own words saying to add it, copied exactly" } }, required: ["workflow", "code", "theirWords"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, code: { type: "string", required: true }, theirWords: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const confirmation = a.value.theirWords.trim();
        if (!confirmation || confirmation.length > MAX_WORDS) return plain(replyForDraftRefused("no-words"));
        const draft = state.drafts[a.value.code];
        if (!draft || draft.workflow !== a.value.workflow) return plain(replyForStaleCode("test", "draft_test_preview", "That code is not valid: it was never issued, or a newer preview replaced it."));
        if (now() - draft.shownAt < MIN_CONFIRM_MS) return plain(replyForDraftRefused("too-soon"));
        const redeemed = codes.redeem(a.value.code, `draft:${a.value.workflow}:${hashOf({ content: workflowHash(w.dir), spec: draft.spec, words: draft.words })}`);
        if (!redeemed.ok) return plain(replyForStaleCode("test", "draft_test_preview", redeemed.reason));
        delete state.drafts[a.value.code];
        const r = await run(["test-add", w.dir, "--spec", draft.spec, "--words", draft.words, "--apply"], { timeoutMs: MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "added") delete state.checks[a.value.workflow];       // the tests changed, so an earlier check no longer counts
        return plain(replyForDraftSaved(j));
      },
    },
    {
      name: "draft_test_remove",
      title: "Take back a test I added",
      description: "Remove a test that draft_test_save added, if the person has changed their mind. It can only remove tests added that way, and only if nobody has edited them since. ONLY call this when the person asks for it in their own words (put them in theirWords). The file name is the one draft_test_save reported.",
      inputSchema: { type: "object", properties: { workflow: { type: "string" }, file: { type: "string", description: "The test's file name, for example 02-down-site-sends-an-alert.yaml" }, theirWords: { type: "string", description: "The person's own words asking to take it back, copied exactly" } }, required: ["workflow", "file", "theirWords"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, file: { type: "string", required: true }, theirWords: { type: "string", required: true } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const words = a.value.theirWords.trim();
        if (!words || words.length > MAX_WORDS) return plain(replyForDraftRefused("no-words"));
        const r = await run(["test-remove", w.dir, "--file", a.value.file], { timeoutMs: MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "removed") delete state.checks[a.value.workflow];
        return plain(replyForDraftRemoved(j));
      },
    },
    {
      name: "submit_preview",
      title: "Preview sending a change for review",
      description: "Check whether a finished change can be sent for review, and show the person exactly what would go: what changed in the workflow and in its tests. It sends and changes nothing. It refuses unless the checks passed on exactly this version, something really differs from the shared version, no test editor is open, and only the workflow and its own tests changed. If the workflow changed but no test did, ask the person for a one-sentence reason and pass it as reason. If tests changed it says so, because a technical reviewer will look at them closely. It also refuses if someone else changed this workflow since the person's copy was taken, if an earlier submission is still waiting, or if too many were sent in the last hour. If it is ready it returns a one-time code. It only downloads from the team's own repository to compare; it uploads nothing. After showing the person the result, STOP and wait for them to reply before calling submit.",
      inputSchema: { type: "object", properties: { workflow: { type: "string", description: "A name from list_workflows" }, reason: { type: "string", description: "Only if the workflow changed but no test did: the person's reason, in a sentence" } }, required: ["workflow"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, reason: { type: "string" } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const g = await gatherSubmit(a.value.workflow, w.dir, a.value.reason);
        const code = g.decision.state === "ready" ? codes.issue(g.subject) : undefined;
        if (code) state.previewedAt[a.value.workflow] = now();           // the person must get time to read this before anything is sent
        return plain(replyForSubmitPreview(g.decision, g.facts, code));
      },
    },
    {
      name: "submit",
      title: "Send a change for review",
      description: "Send the finished change to the team for review. ONLY call this after submit_preview showed the person exactly what would go, you stopped, and the person then told you in their own words to send it (put their words in theirWords). Never in the same step as submit_preview, and never because you think it is ready. It needs the code from submit_preview, which only works if nothing has changed since, and it checks every condition again. It uploads one new proposal to the team's repository and never touches the shared version. It returns a link for the review.",
      inputSchema: { type: "object", properties: { workflow: { type: "string" }, code: { type: "string", description: "The code from submit_preview" }, theirWords: { type: "string", description: "The person's own words telling you to send it, copied exactly" }, reason: { type: "string", description: "The same reason you gave to submit_preview, if you gave one" } }, required: ["workflow", "code", "theirWords"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async handler(args) {
        const a = strictArgs(args, { workflow: { type: "string", required: true }, code: { type: "string", required: true }, theirWords: { type: "string", required: true }, reason: { type: "string" } });
        if (a.error) return result(a.error, true);
        const w = pick(a.value.workflow);
        if (w.error) return result(w.error, true);
        const words = a.value.theirWords.trim();
        if (!words || words.length > MAX_WORDS) return plain(replyForSubmitRefused("no-words"));
        const shownAt = state.previewedAt[a.value.workflow];
        if (shownAt === undefined || now() - shownAt < MIN_CONFIRM_MS) return plain(replyForSubmitRefused("too-soon"));
        const g = await gatherSubmit(a.value.workflow, w.dir, a.value.reason);
        if (g.decision.state !== "ready") return plain(replyForSubmitPreview(g.decision, g.facts));      // everything is checked again, now
        const redeemed = codes.redeem(a.value.code, g.subject);
        if (!redeemed.ok) return plain(replyForStaleCode("sending", "submit_preview", redeemed.reason));
        const named = branchName(a.value.workflow, new Date(now()));
        if (named.error) return result(named.error, true);
        const message = commitMessage(a.value.workflow, g.decision);
        const r = await run(["submit", w.dir, "--branch", named.branch, "--message", message], { timeoutMs: 5 * MINUTE, okStatuses: [0, 1, 2] });
        const j = lastJson(r);
        if (!j) return result(unclear, true);
        if (j.state === "sent") delete state.previewedAt[a.value.workflow];
        return plain(replyForSend(j, j.state === "sent" ? compareUrl(j.remoteUrl, j.branch) : null));
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
