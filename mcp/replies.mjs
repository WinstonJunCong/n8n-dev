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

// ---------- what an earlier editor left behind ----------
const ageOf = (s) => (typeof s.age === "string" && s.age ? s.age : "earlier");       // the command line says it in words (see agePhrase in session.mjs)
const DRIFT_NOTE = "The workflow has changed since then, so those edits may no longer fit it.";

// The offer: what was found, how old it is, and the choices. Never acts.
export function describeOffer(s) {
  const age = ageOf(s);
  const n = s.changes ?? 0;
  const head = {
    "editor-running": `A test editor from ${age} is still open, with your changes in it.`,
    "editor-stopped": `A test editor from ${age} was stopped (probably by a restart), but your changes are still safe in it.`,
    "editor-orphan": "Something from an earlier test editor is still here.",
    "saved-edits": `You have ${n} change${n === 1 ? "" : "s"} from ${age} that were saved when the editor closed but never applied to your workflow.`,
  }[s.kind];
  if (!head) return null;
  const notes = [];
  if (s.stale) notes.push(`That's from ${age}, so it may be out of date. Throwing it away is usually the safe choice.`);
  if (s.drift) notes.push(DRIFT_NOTE);
  const editor = s.kind === "editor-running" || s.kind === "editor-stopped";
  const choices = s.kind === "saved-edits" ? (s.drift ? "I can throw them away." : "I can show you what they are, or throw them away.")
    : editor ? (s.drift ? "I can close it and keep the changes for a look, or throw it away." : "I can bring it back so you can carry on, close it and keep your changes, or throw it away.")
    : "I can close it, or throw it away.";
  const hint = s.kind === "saved-edits"
    ? `offer: pull_preview for ${s.workflow ?? "the workflow"} to show what changed${s.drift ? " (it will refuse, the workflow moved)" : ""}; ui_discard to throw them away (needs their own words). Ask which, then wait`
    : `offer: ${s.drift ? "" : "ui_resume to carry on; "}ui_stop to save the changes and close it; ui_discard to throw it away (needs their own words). Ask which, then wait`;
  return { text: [head, ...notes, choices].join(" "), hint };
}

export function replyForSession(s) {
  const offer = s && describeOffer(s);
  if (offer) return reply(offer.text, offer.hint);
  if (s?.kind === "unknown") return reply("I can't tell right now whether a test editor is open. Is Docker Desktop running?", undefined, true);
  return reply("No test editor is open, and nothing is waiting from earlier.");
}

// A start that was refused because something from before is still there: say what, and offer the choices.
export function replyForStartRefused(j) {
  const offer = j.session && describeOffer(j.session);
  if (!offer) return null;
  return reply(`I haven't opened a new editor, because there is already something from before. ${offer.text}`, offer.hint, true);
}

export function replyForResume(j) {
  if (j.state === "resumed") {
    const login = j.login ? ` Sign in with the email ${j.login.email} and the password ${j.login.password}.` : "";
    return reply(`Your earlier test editor is back, with your changes in it. Open this address in your browser: ${j.address}.${login}\n\nTake your time. When you have finished, tell me “I'm done” and I'll close it and keep your changes.`,
      "give the person the address and sign-in, then STOP and wait. Call ui_stop only when they say they are finished, with their words as theirWords");
  }
  if (j.state === "drifted") {
    const offer = j.session && describeOffer(j.session);
    return reply(`I haven't brought it back. ${DRIFT_NOTE}${offer ? ` I can close it and keep the changes for a look, or throw it away.` : ""}`, "offer ui_stop (save and close) or ui_discard (throw away, needs their words)", true);
  }
  const plain = {
    "nothing-to-resume": "There is no earlier test editor to bring back.",
    failed: "I couldn't bring the editor back. Make sure Docker Desktop is open and running, then ask me to try again.",
  }[j.state] ?? "I couldn't bring the editor back.";
  return reply(plain + technical(j.state === "failed" ? j.details : ""), undefined, true);
}

export function replyForDiscard(j) {
  if (j.state === "no-words") return reply("I haven't thrown anything away, because I need you to tell me that's what you want. Say the word and I'll do it.", "ask the person; call ui_discard only with their own words as theirWords", true);
  if (j.state === "discarded") {
    return reply(j.cleaned
      ? "Done. The earlier test editor, and any changes saved from it, are thrown away. Your workflow and your tests haven't been touched."
      : "I threw it away, but something from it may still be left behind. Your workflow and your tests haven't been touched.", undefined, !j.cleaned);
  }
  return reply("I couldn't throw it away. Nothing was changed.", undefined, true);
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
  if (j.state === "already-applied") return reply("Those changes were already applied to your workflow, so there is nothing waiting.");
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
      "call check_workflow now. If the checks now fail, tell the person plainly which test failed and why, then call explain_test_failures (and offer undo_change)");
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

// ---------- tests that fail because of the person's change ----------
const WHY = {
  error: (t) => `The test ${q(t.test)} couldn't run at all`,
  "not-text": (t) => `The test ${q(t.test)} is failing, and not because of any wording you changed`,
  unrelated: (t) => `The test ${q(t.test)} is failing, and not because of any wording you changed`,
  mismatch: (t) => `The test ${q(t.test)} is failing, and your wording change only explains part of it`,
  "no-actual": (t) => `The test ${q(t.test)} is failing, and I can't tell why`,
};
const unexplainedLines = (list = []) => list.map((u) => {
  const head = (WHY[u.reason] ?? WHY["no-actual"])(u);
  return u.assertion ? `${head}: ${plainAssertion({ assertion: u.assertion, detail: u.detail })}` : head;
});
const updateLines = (list = []) => list.map((u) => `The test ${q(u.test)} currently expects ${q(u.from)}. It would expect ${q(u.to)} instead`);
const NEEDS_COLLEAGUE = "Those need someone who knows the tests, so I won't change them. If you'd rather go back to how things were, I can undo your change.";

export function replyForTestFix(j, code) {
  if (j.state === "no-change") return reply("I can't tell which tests your change affects, because no change has been applied yet.", undefined, true);
  if (j.state === "wrong-workflow") return reply(`Your latest applied change is for ${q(j.expected)}, not ${q(j.given)}.`, undefined, true);
  if (j.state === "failed") return reply("I couldn't look at the tests just now. Make sure Docker Desktop is open and running, then ask me to try again.", undefined, true);
  if (j.state === "nothing") return reply("None of the tests need changing: nothing is failing because of your change.");
  const left = unexplainedLines(j.unexplained);
  if (j.state === "unexplained") {
    return reply(`Your change affects some tests, but not in a way I can safely fix on my own.\n${bullets(left)}\n\n${NEEDS_COLLEAGUE}`, "offer undo_change if the person wants to go back");
  }
  if (j.state === "ready") {
    return reply(
      `Some tests still expect the old wording, so they now fail. Your change explains each of these exactly:\n${bullets(updateLines(j.updates))}\n\n` +
      `Did you mean to change that on purpose? If so, I can update just those tests to match. Nothing has been changed yet.` +
      (left.length ? `\n\nSeparately, these are failing for other reasons:\n${bullets(left)}\n\n${NEEDS_COLLEAGUE}` : ""),
      `ask the person to confirm they changed it on purpose, then call update_tests with the code ${code}`);
  }
  return reply("I can't update the tests right now.", undefined, true);
}

export function replyForTestUpdate(j) {
  if (j.state === "applied") {
    const lines = (j.updates ?? []).map((u) => `The test ${q(u.test)} now expects ${q(u.to)} (it used to expect ${q(u.from)})`);
    return reply(`Done. I updated these tests to match your change:\n${bullets(lines)}\n\nI'd run the checks again to be sure everything passes.`, "call check_workflow now");
  }
  if (j.state === "write-failed") return reply("I couldn't update the tests. Nothing was changed.", undefined, true);
  return replyForTestFix(j);
}

// ---------- tests written from the person's own words ----------
const wordsOf = (s) => String(s).replace(/[._]+/g, " ");
const valueText = (v) => {
  if (typeof v === "string") return q(v);
  if (v !== null && typeof v === "object") { const t = JSON.stringify(v); return t.length > 60 ? `${t.slice(0, 57)}…` : t; }
  return String(v);
};
const pairsText = (obj) => Object.entries(obj ?? {}).map(([k, v]) => `${wordsOf(k)} = ${valueText(v)}`).join(", ");

// The "when / then" of a test, as plain sentences.
export function describeWhenThen(j) {
  const when = [];
  const trigger = pairsText(j.when?.trigger);
  when.push(trigger ? `A request comes in with ${trigger}` : "A request comes in");
  for (const [step, rows] of Object.entries(j.when?.services ?? {})) when.push(`${q(step)} answers with ${rows.map(pairsText).join(", and then with ")}`);
  const then = (j.then ?? []).map((t) => {
    if ("endsAt" in t) return `The workflow finishes at ${q(t.endsAt)}`;
    if ("runs" in t) return t.runs === 1 ? `${q(t.step)} runs once` : `${q(t.step)} runs ${t.runs} times`;
    if ("doesNotRun" in t) return `${q(t.step)} does not run`;
    const op = "is" in t ? "is" : "isNot" in t ? "is not" : "contains";
    const value = t.is ?? t.isNot ?? t.contains;
    return `The ${wordsOf(t.field)} going ${t.side === "output" ? "out of" : "into"} ${q(t.step)} ${op} ${valueText(value)}`;
  });
  return { when, then };
}

const DRAFT_ERRORS = {
  "bad-name": () => "The test needs a short name that describes it.",
  "name-taken": (e) => `There is already a test called ${q(e.name)}. Give this one a different name.`,
  "unknown-step": (e) => `There is no step called ${q(e.step)} in this workflow.${e.steps?.length ? ` The steps are: ${e.steps.map(q).join(", ")}.` : ""}`,
  "not-outside": (e) => `${q(e.step)} isn't a step that talks to an outside service, so it can't be given a pretend answer.${e.outside?.length ? ` The ones that can are: ${e.outside.map(q).join(", ")}.` : ""}`,
  "empty-then": () => "The test needs at least one thing that should happen.",
  "too-many-checks": (e) => `That is more than ${e.max} things for one test. Split it into smaller tests.`,
  "duplicate-check": () => "The same thing is checked twice.",
  "step-name-unsupported": (e) => `The step ${q(e.step)} has a name that tests can't refer to.`,
  "too-many-tests": (e) => `That would take this workflow past ${e.max} tests, which is the most I'll add.`,
  "too-many-in-preview": (e) => `That is more than ${e.max} tests at once. Let's do the most important ones first.`,
  "no-words": () => "I need your own words describing what should happen, so the test can show where it came from.",
};
const DRAFT_FORMAT = 'spec is JSON: {"name":"…","when":{"trigger":{…},"services":{"<outside step>":[{…}]}},"then":[{"step":"S","runs":1} | {"step":"S","doesNotRun":true} | {"step":"S","side":"input|output","field":"a.b","is|contains|isNot":"v"} | {"endsAt":"S"}]}';

export function replyForDraftPreview(j, code, words) {
  if (j.state === "invalid") {
    const several = (j.count ?? 1) > 1;
    const own = (j.errors ?? []).filter((e) => DRAFT_ERRORS[e.code]).map((e) => {
      const line = DRAFT_ERRORS[e.code](e);
      return several && e.index !== undefined ? `Test ${e.index + 1}${e.testName ? ` (${q(e.testName)})` : ""}: ${line}` : line;
    });
    const plain = own.length ? `I can't add ${several ? "those tests" : "that test"} yet:\n${bullets(own)}` : "I need to adjust how I've described the test before I can show it to you. Nothing has been added.";
    return reply(plain, `fix the description and call draft_test_preview again (put every test for this request in ONE preview, as a list); problems: ${JSON.stringify(j.errors)}. ${DRAFT_FORMAT}`, false);
  }
  if (j.state !== "ready" || !Array.isArray(j.tests)) return reply("I couldn't prepare that test. Nothing has been added.", undefined, true);
  const many = j.tests.length > 1;
  const parts = [many ? `Here are the ${j.tests.length} tests I would add, from what you told me.` : "Here is the test I would add, from what you told me.", `You said: ${q(words)}`];
  j.tests.forEach((t, i) => {
    const wt = describeWhenThen(t);
    parts.push(`${many ? `Test ${i + 1}: ${q(t.name)}\n` : ""}When:\n${bullets(wt.when)}\n\nThen:\n${bullets(wt.then)}`);
    if (t.unmocked?.length) parts.push(`${many ? `In test ${i + 1}, these` : "These"} steps talk to outside services but have no pretend answer here: ${t.unmocked.map(q).join(", ")}. If the test reaches one of them it will stop with an error, so tell me if one of them should answer something.`);
  });
  parts.push(many ? "These tests will fail until your workflow does this, except any that already hold today. That's expected: it is the thing you are about to build." : "This test will fail until your workflow does this. That's expected: it is the thing you are about to build.");
  parts.push(many ? "Nothing has been added yet. If that is what you want, say so and I'll add them all." : "Nothing has been added yet. If that is what you want, say so and I'll add it.");
  return reply(parts.join("\n\n"), `the one-time code is ${code}. Show the person the above and STOP: wait for them to say yes in their own words. Only then call draft_test_save with this code and their words as theirWords. If they want a change, call draft_test_preview again with the WHOLE set. If the code is later reported out of date, preview again, show it, and wait for a reply: never preview and save in the same step`);
}

export function replyForDraftRefused(why) {
  if (why === "too-soon") return reply("I need your go-ahead first. Have a look at the test, and tell me if you'd like me to add it.", "do not call draft_test_save yet: the person has not had time to read the preview. Show it and wait for their reply", true);
  return reply("I haven't added anything, because I need to hear from you that you want it. Tell me and I'll add it.", "ask the person; call it only with their own words as theirWords", true);
}

export function replyForDraftSaved(j) {
  if (j.state === "added" && Array.isArray(j.tests)) {
    const names = j.tests.map((t) => q(t.name));
    const intro = j.tests.length === 1 ? `Added the test ${names[0]}. It will fail until your workflow does this, which is expected.` : `Added ${j.tests.length} tests:\n${bullets(names)}\n\nThey will fail until your workflow does this, except any that already hold today. That is expected.`;
    return reply(`${intro}\n\nThe next step is to open the test editor and make the change.`,
      `offer to open the editor with ui_start; the new tests are loaded with the others. If they change their mind, draft_test_remove takes one back (one call per file: ${j.tests.map((t) => t.file).join(", ")})`);
  }
  if (j.state === "invalid") return replyForDraftPreview(j);
  return reply("I couldn't add the test. Nothing was changed.", undefined, true);
}

export function replyForDraftRemoved(j) {
  const plain = {
    removed: `Removed the test ${j.name ? q(j.name) : "you asked about"}. Nothing else was touched.`,
    "already-gone": "That test was already gone.",
    "not-drafted": "I can only take back tests that I added for you in this way, so I've left that one alone.",
    "changed-since": "Someone has edited that test since I wrote it, so I've left it alone to keep their changes.",
    "bad-file": "That doesn't look like the name of a test.",
  }[j.state] ?? "I couldn't remove it. Nothing was changed.";
  return reply(plain, undefined, !["removed", "already-gone"].includes(j.state));
}

// A code that no longer works (too old, replaced, or the content changed). The person is told plainly; the assistant is told
// what to do: show a fresh preview and wait for a reply, never preview and save in the same step.
export function replyForStaleCode(what, previewTool, reason) {
  return reply(`That preview of the ${what} is out of date, so I need to show it to you again before anything happens.`,
    `${reason ?? "The code no longer works."} Call ${previewTool} again, show the person the new preview, and STOP: wait for their reply before the save step. Never preview and save in the same step.`, true);
}

// ---------- sending a change for review ----------
const SUBMIT_BLOCKS = {
  "editor-open": () => "The test editor is still open. Tell me when you've finished with it and I'll close it first.",
  "editor-unknown": () => "I can't tell whether the test editor is still open. Is Docker Desktop running?",
  "no-check": () => "I haven't checked this version yet.",
  "check-stale": () => "Something changed since the last check, so I need to check again.",
  "check-failed": () => "The latest check failed, so this can't be sent for review yet. It needs fixing first, or I can undo the change.",
  "no-change": () => "There is nothing different from the shared version, so there is nothing to send.",
  "other-files": (r) => `Besides the workflow and its tests, ${r.count} other file${r.count === 1 ? "" : "s"} changed. I only send a workflow and its own tests, so those need a colleague.`,
  "workflow-without-test": () => "You changed the workflow, but no test goes with it. Changes to what a workflow does should come with a test. If there is a good reason there isn't one, tell me why and I'll pass the reason on to the reviewer.",
  "reason-too-long": () => "That reason is too long. Please give it in a sentence or two.",
  "no-git": () => "The tool that keeps track of changes isn't installed on this computer, so I can't send changes for review.",
  "no-repo": () => "This folder isn't set up for sharing changes, so I can't send anything for review.",
  "no-base": () => "I can't find the shared version to compare with, so I can't tell what is different.",
  "no-facts": () => "I couldn't work out what is different from the shared version.",
  "shared-changed": () => "Someone else has changed this workflow since your copy was taken. Sending yours now would undo their work, so it can't go. It needs to be started again from the latest version: ask an admin to bring your copy up to date.",
  "open-submission": () => "You already have a change to this workflow waiting for review. Wait until it has been reviewed before sending another.",
  "rate-limit": (r) => `You've already sent ${r.max} changes in the last hour. Please wait a little before sending another.`,
};
const SUBMIT_HINTS = { "no-check": "call check_workflow", "check-stale": "call check_workflow", "editor-open": "ask whether they have finished with the editor; call ui_stop only with their own words", "workflow-without-test": "ask the person for a one-sentence reason, then call submit_preview again with it as reason" };
const GIT_PROBLEMS = new Set(["no-git", "no-repo", "no-base", "no-facts"]);

const testLine = (t) => {
  const name = t.name ? q(t.name) : "a test";
  if (t.status === "A") return `A new test: ${name}`;
  if (t.status === "D") return `The test ${name} was removed`;
  return `The test ${name} was changed`;
};

export function replyForSubmitPreview(decision, facts, code) {
  if (decision.state === "blocked") {
    const lines = decision.reasons.map((r) => (SUBMIT_BLOCKS[r.code] ?? (() => "Something stops this from being sent."))(r));
    const hint = decision.reasons.map((r) => SUBMIT_HINTS[r.code]).filter(Boolean)[0];
    return reply(`This can't be sent for review yet:\n${bullets(lines)}`, hint, decision.reasons.some((r) => GIT_PROBLEMS.has(r.code)));
  }
  const parts = ["Everything is in order to send this for review. This is what would go:"];
  if (facts.newWorkflow) parts.push("A brand new workflow.");
  else if (facts.workflowChanged) {
    const lines = describeChanges(facts.workflowChanges ?? []);
    parts.push(`What changed in the workflow:\n${bullets(lines.length ? lines : ["The workflow was changed."])}`);
  }
  if (facts.tests?.length) parts.push(`Tests:\n${bullets(facts.tests.map(testLine))}`);
  parts.push("The checks passed on exactly this version.");
  if (decision.testsRemoved) parts.push("Tests were removed. The reviewer will want to know why.");
  else if (decision.testsChanged) parts.push("Because tests were changed, a technical reviewer will look at those closely before anything goes live.");
  if (decision.noTestReason) parts.push(`No test changed. You told me why: ${q(decision.noTestReason)}.`);
  if (facts.fetched === false) parts.push("I couldn't reach the team's repository just now, so this comparison might be out of date.");
  parts.push("Nothing has been sent yet. If you'd like me to send it for review, say so.");
  return reply(parts.join("\n\n"), `the one-time code is ${code}. Show the person the above, then STOP and wait for them to tell you in their own words to send it. Only then call submit with this code and their words as theirWords (and the same reason, if any)`);
}

export function replyForSubmitRefused(why) {
  if (why === "too-soon") {
    return reply("I need your go-ahead first. Have a look at what would be sent, and tell me if you'd like me to send it.",
      "do not call submit yet: the person has not had time to read the preview. Show it and wait for their reply", true);
  }
  return reply("I haven't sent anything, because I need to hear from you that you want it sent. Tell me and I'll send it.",
    "ask the person; call submit only with their own words as theirWords", true);
}

export function replyForSend(j, link) {
  if (j.state === "sent") {
    return reply(`Sent for review. It is not live: a reviewer has to look at it and approve it first.\n\n${link ? `Open this link to start the review: ${link}` : "I couldn't make a link for it, so let a colleague know it is waiting for review."}`,
      "tell the person what happens next: a reviewer looks at it; they will be told if it needs changes");
  }
  const plain = {
    nothing: "There was nothing different to send, so I didn't send anything.",
    "push-failed": "I couldn't send it. Your computer may not be signed in to the team's repository, or you may be offline. Nothing was changed.",
    "no-identity": "Your computer doesn't know who you are for sharing changes, so I can't send this. A colleague can set that up once for you.",
    "no-remote": "This folder isn't connected to the team's repository, so I can't send anything.",
    "no-git": "The tool that keeps track of changes isn't installed on this computer, so I can't send changes for review.",
    "no-repo": "This folder isn't set up for sharing changes, so I can't send anything for review.",
    "no-base": "I can't find the shared version to compare with, so I can't send anything.",
  }[j.state] ?? "I couldn't send it. Nothing was changed.";
  return reply(plain + technical(j.state === "push-failed" ? j.details : ""), undefined, j.state !== "nothing");
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
