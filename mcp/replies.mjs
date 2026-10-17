// Turns facts from the command line (its --json output) into replies a non-technical person can read. Pure: no I/O.
//
// Rules, pinned by replies.test.mjs:
//  - The part meant for the person never mentions a command, a flag, a file or folder name of ours, or technical
//    words (node, mock, chamber, dry run, YAML ...). The tool talks in steps, tests, checks and "the safe test editor".
//  - It never asks the person to run anything. The assistant does everything through its tools.
//  - When something changed it says WHAT, with the old and new text, so nobody has to go and look.
// Each reply may end with a line for the assistant (tool names, next steps). That line is marked, so it is never read
// out to the person.

const ASSISTANT = "For you, the assistant (do not read this part out):";
const q = (s) => `“${s}”`;
const withHint = (plain, hint) => (hint ? `${plain}\n\n${ASSISTANT} ${hint}` : plain);
const reply = (plain, hint, isError = false) => ({ text: withHint(plain, hint), isError });
const technical = (details) => (details ? `\n\nTechnical details (for support): ${String(details).trim().slice(-300)}` : "");

// Words that must never appear in the part meant for the person.
export const JARGON = [
  /\bnodes?\b/i, /\bmocks?\b/i, /\bchamber\b/i, /dry[- ]run/i, /readiness/i, /\byaml\b/i, /\bjson\b/i, /\bstdout\b|\bstderr\b|exit code/i,
  /\bnpm\b|\bgit\b|\bdocker\b/i, /\bterminal\b|\bcommand\b|\bcommand line\b/i, /--[a-z]/i, /\.n8n-dev|ui-export|workflow\.json|\.mjs|harness/i,
  /\bpull[_ ]?(?:preview|apply|request)?\b/i,
];

// ---------- what changed ----------
const detailLine = (node, d) => `In ${q(node)}, the ${d.label} changed from ${q(d.from)} to ${q(d.to)}`;

export function describeChanges(changes = []) {
  const lines = [];
  for (const c of changes) {
    if (c.kind === "changed") {
      if (c.details?.length) for (const d of c.details) lines.push(detailLine(c.node, d));
      else lines.push(`${q(c.node)} was changed`);
    } else if (c.kind === "renamed") lines.push(`${q(c.node)} was renamed to ${q(c.to)} (tests refer to steps by name, so a test may need updating)`);
    else if (c.kind === "added") {
      lines.push(`A new step was added: ${q(c.node)}`);
      if (c.outside) lines.push(`${q(c.node)} contacts an outside service. Tests never contact real services, so it needs a pretend answer in the tests before this can be sent for review`);
      if (c.trigger) lines.push(`${q(c.node)} would be a second starting point, and a workflow can only have one`);
    } else if (c.kind === "removed") lines.push(`The step ${q(c.node)} was removed`);
    else if (c.kind === "connected") lines.push(`${q(c.from)} is now connected to ${q(c.to)}`);
    else if (c.kind === "disconnected") lines.push(`${q(c.from)} is no longer connected to ${q(c.to)}`);
  }
  return lines;
}

const NOT_APPLIED = {
  "simulated-edited": (n) => `You also changed the pretend answer for ${q(n)}. That is only a stand-in used while testing, so I left it out of your workflow`,
  "simulated-removed": (n) => `You deleted the stand-in for ${q(n)}. Your workflow still has the real step, so nothing was removed`,
  credentials: (n) => `A login set on ${q(n)} in the test editor was ignored: logins never come from the test editor`,
};

export function describeNotApplied(items = []) {
  return items.map((i) => (NOT_APPLIED[i.reason] ?? ((n) => `A change to ${q(n)} was left out`))(i.node));
}

const bullets = (lines) => lines.map((l) => `• ${l}`).join("\n");
const changesBlock = (facts) => {
  const parts = [];
  const changes = describeChanges(facts.changes);
  if (changes.length) parts.push(`What you changed in your workflow:\n${bullets(changes)}`);
  const left = describeNotApplied(facts.notApplied);
  if (left.length) parts.push(`${changes.length ? "Also" : "Note"}:\n${bullets(left)}`);
  if (facts.missing?.length) parts.push(`Some test copies were not saved (${facts.missing.map(q).join(", ")}), so changes made in them are not included.`);
  if (facts.conflicts?.length) parts.push("Two of your test copies were changed in different ways, so I can't tell which change you want. Close the test editor, then open it again and make the change in just one test.");
  if (facts.changedMeanwhile) parts.push("The workflow was also edited somewhere else while the test editor was open, so combining your changes could undo that.");
  return parts.join("\n\n");
};

// ---------- the safe test editor ----------
export function replyForStart(j) {
  if (j.state === "started") {
    const login = j.login ? ` Sign in with the email ${j.login.email} and the password ${j.login.password}. These only work inside this temporary editor.` : "";
    return reply(
      `The safe test editor is open. Open this address in your browser: ${j.address}.${login}\n\n` +
      `You will see a copy of each test. Open one and click “Execute workflow” to watch it run. Change anything you like: it can't reach the internet or touch your real workflow. ` +
      `Boxes on a grey backdrop are pretend stand-ins for outside services; everything else is your real workflow. Changes save by themselves after a couple of seconds.\n\n` +
      `Take your time. When you have finished, just tell me “I'm done” and I'll close it and keep your changes. I won't close it until you say so.`,
      "give the person the address and sign-in, then STOP. Do not call any other tool until the person writes back. Call ui_stop only when they say they are finished, and pass their words as theirWords");
  }
  const plain = {
    "already-running": "A test editor is already open (perhaps from earlier). Tell me to close it first and I'll keep any changes you made in it.",
    "docker-missing": "I can't open the test editor because Docker Desktop isn't running. Open Docker Desktop, wait until it says it is running, and ask me again.",
    "no-tests": "This workflow has no tests yet, so there is nothing to open. Tests are what the editor shows.",
    "bad-port": "That port number can't be used. Pick one between 1024 and 65535, or just let me choose.",
    "build-failed": "I couldn't prepare the tests for the editor. Something in this workflow's tests needs fixing first.",
    failed: "The test editor didn't start. Make sure Docker Desktop is open and running, then ask me to try again.",
  }[j.state] ?? "The test editor didn't start.";
  const hint = j.state === "already-running" ? "call ui_stop to save and close the open one, then ui_start again" : undefined;
  return reply(plain + technical(j.state === "failed" || j.state === "build-failed" ? (j.details || j.message) : ""), hint, true);
}

export function replyForStop(j) {
  if (j.state === "no-session") return reply("There is no test editor session to close.", undefined, false);
  if (j.state === "nothing-running") return reply("No test editor was open, so there was nothing to save.", undefined, false);
  const facts = j.summary ?? {};
  const body = changesBlock(facts);
  const closed = j.cleaned ? "I closed the test editor and kept your changes safely." : "I saved your changes, but the test editor may not have closed completely.";
  const any = (facts.changes?.length ?? 0) > 0;
  return reply(
    `${closed}${body ? `\n\n${body}` : "\n\nYou didn't change anything in your workflow."}${any ? "\n\nWant me to apply these to your workflow? I'll show you exactly what will change first." : ""}`,
    any ? "if they want to apply, call pull_preview, describe the changes, and get their agreement before pull_apply" : undefined,
    !j.cleaned);
}

export function replyForStopRefused(why) {
  if (why === "too-soon") {
    return reply("The test editor was only just opened, and the person hasn't had time to use it yet, so I have left it open. I'll close it when you tell me you've finished.",
      "do not call ui_stop again now. Tell the person the editor is open, repeat the address and sign-in, and wait for them to say they are finished", true);
  }
  return reply("I didn't close the test editor, because I need to hear from you that you've finished. Tell me when you're done and I'll close it.",
    "ask the person whether they are finished; call ui_stop only with their own words", true);
}

// ---------- applying changes ----------
const FINDING = {
  secret: "a key or password typed straight into a step",
  "airtable-id": "an ID typed straight into a step (it should come from the settings table)",
  "chat-id": "a chat ID typed straight into a step (it should come from the settings table)",
  host: "a web address typed straight into a step (it should come from the settings table)",
  "live-n8n": "a call to your live n8n, which tests must never make",
};
const findingLine = (f) => `${q(f.node)} has ${FINDING[f.rule] ?? "something that should not be typed into a step"}`;

function blocked(j) {
  if (j.reason === "conflict") return "I can't apply these: two of your test copies were changed in different ways, so I can't tell which change you want. Close the test editor, open it again and make the change in just one test.";
  if (j.reason === "changed-meanwhile") return "I can't apply these safely: the workflow was changed somewhere else after the test editor opened, so applying your edits might undo that. Open a fresh test editor and make the change again.";
  if (j.reason === "scan") return `I can't apply these: the result would put something unsafe straight into a step.\n${bullets((j.findings ?? []).map((f) => findingLine(f)))}`;
  return "I can't apply these right now.";
}

export function replyForPreview(j, code) {
  if (j.state === "no-session") return reply("I don't have any saved changes to look at. Open the test editor, make a change, then close it so I can keep it.", "call ui_start, then ui_stop once the person is done", true);
  if (j.state === "wrong-workflow") return reply(`Your latest saved changes are for ${q(j.expected)}, not ${q(j.given)}.`, undefined, true);
  if (j.state === "blocked") return reply(`${blocked(j)}${(j.findings ?? []).length ? "" : `\n\n${changesBlock(j)}`}`, undefined, true);
  if (j.state === "nothing") {
    const left = describeNotApplied(j.notApplied);
    return reply(`There is nothing to apply: you didn't change any real step of your workflow.${left.length ? `\n\n${bullets(left)}` : ""}`);
  }
  return reply(
    `${changesBlock(j)}\n\nNothing has been changed yet. If you're happy with this, say so and I'll apply it.`,
    `ask the person to confirm, then call pull_apply with the code ${code}`);
}

export function replyForApply(j) {
  if (j.state === "applied") {
    const lines = describeChanges(j.changes);
    return reply(
      `Done. Your change is now in the workflow ${q(j.workflow.split("/").pop())}.${lines.length ? `\n\n${bullets(lines)}` : ""}\n\nI'd run the checks again before anything else.`,
      "call check_workflow now. If the checks now fail, tell the person plainly which test failed and why, and offer to undo the change with undo_change");
  }
  if (j.state === "write-failed") return reply("I couldn't save the change to your workflow. Nothing was changed.", undefined, true);
  return replyForPreview(j);
}

// ---------- undo ----------
// What an undo takes back, said from the person's side (the saved changes describe what the apply did).
export function describeUndone(changes = []) {
  const lines = [];
  for (const c of changes) {
    if (c.kind === "changed") {
      if (c.details?.length) for (const d of c.details) lines.push(`In ${q(c.node)}, the ${d.label} is back to ${q(d.from)} (it had been changed to ${q(d.to)})`);
      else lines.push(`${q(c.node)} is back as it was`);
    } else if (c.kind === "renamed") lines.push(`${q(c.to)} is called ${q(c.node)} again`);
    else if (c.kind === "added") lines.push(`The step ${q(c.node)} was taken out again`);
    else if (c.kind === "removed") lines.push(`The step ${q(c.node)} was put back`);
    else if (c.kind === "connected") lines.push(`${q(c.from)} is no longer connected to ${q(c.to)}`);
    else if (c.kind === "disconnected") lines.push(`${q(c.from)} is connected to ${q(c.to)} again`);
  }
  return lines;
}

export function replyForUndo(j) {
  if (j.state === "restored") {
    const lines = describeUndone(j.changes);
    return reply(`Done. Your workflow is back to how it was before the change.${lines.length ? `\n\n${bullets(lines)}` : ""}`, "call check_workflow to confirm it is healthy again");
  }
  const plain = {
    "no-words": "I didn't undo anything, because I need you to tell me you want to go back. Say the word and I'll do it.",
    "nothing-to-undo": "There is nothing to undo: no change has been applied that I can take back.",
    "already-undone": "Your workflow is already back to how it was before the change.",
    "changed-since": "I can't undo this safely: the workflow has been changed again since that change was applied, and going back would throw away that newer work.",
    missing: "I can't undo this: the workflow I would restore can't be found.",
    "write-failed": "I couldn't put the workflow back. Nothing was changed.",
  }[j.state] ?? "I couldn't undo that.";
  return reply(plain, undefined, !["already-undone", "nothing-to-undo"].includes(j.state));
}

// ---------- checks and status ----------
const ASSERT = [
  [/^node "(.+)" called (\d+) times?$/, (m, d) => `${q(m[1])} should have run ${m[2]} time${m[2] === "1" ? "" : "s"}${d ? ` but ${String(d).replace(/^called (\d+) time\(s\)$/, "ran $1 time(s)")}` : ""}`],
  [/^node "(.+)" not called$/, (m) => `${q(m[1])} should not have run, but it did`],
  [/^node "(.+)" (input|output)\.(\S+) (==|!=|contains) (.+)$/, (m, d) =>
    `${q(m[1])} should ${m[4] === "contains" ? "contain" : m[4] === "==" ? "have" : "not have"} ${m[3]} ${m[4] === "contains" ? "" : "equal to "}${m[5]}${d ? ` (it had: ${d.replace(/^[^=]*= /, "")})` : ""}`.replace(/\s+/g, " ")],
  [/^workflow ends at "(.+)"$/, (m) => `the workflow should have finished at ${q(m[1])}`],
];

export function plainAssertion(check) {
  for (const [re, make] of ASSERT) {
    const m = String(check.assertion).match(re);
    if (m) return make(m, check.detail);
  }
  return String(check.assertion);
}

export function replyForCheck(workflow, report, rawOutput = "") {
  if (!report || typeof report.allPass !== "boolean") {
    return reply(`I couldn't run the checks for ${q(workflow)}. Make sure Docker Desktop is open and running, then ask me to try again.${technical(rawOutput)}`, undefined, true);
  }
  const tests = report.tests ?? [];
  const passed = tests.filter((t) => t.pass).length;
  if (report.allPass) {
    return reply(
      `${q(workflow)} passed every check.\n` +
      `• Nothing unsafe is typed into the steps (no keys, passwords or web addresses).\n` +
      `• The workflow is built correctly.\n` +
      `• ${passed} of ${tests.length} tests passed:\n${tests.map((t) => `   ◦ ${t.name}`).join("\n")}\n\n` +
      `Nothing is stopping this from being sent for review.`);
  }
  const problems = [];
  for (const f of report.scan ?? []) problems.push(findingLine(f));
  for (const s of report.structure ?? []) problems.push(`The workflow isn't built correctly: ${s.message}`);
  let technicalNote = "";
  for (const t of tests.filter((x) => !x.pass)) {
    if (t.error) { problems.push(`The test ${q(t.name)} couldn't run.`); technicalNote = t.error; continue; }
    const first = (t.checks ?? []).find((c) => !c.pass);
    problems.push(`The test ${q(t.name)} failed${first ? `: ${plainAssertion(first)}` : ""}`);
  }
  return reply(
    `${q(workflow)} isn't ready yet. ${tests.length ? `${passed} of ${tests.length} tests passed. ` : ""}What needs fixing:\n${bullets(problems)}${technical(technicalNote)}`,
    undefined, false);
}

export function replyForStatus(exitCode, rawOutput = "") {
  if (exitCode === 0) return reply("No test editor is open.");
  if (exitCode === 1) return reply("A test editor from earlier is still open, or something from it was left behind.", "call ui_stop to save any changes and clean up");
  return reply(`I can't tell right now. Is Docker Desktop running?${technical(rawOutput)}`, undefined, true);
}
