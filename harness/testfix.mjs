// When a change the person made breaks a test only because the test still expects the old wording, this finds those
// tests and works out the one-line update that fixes them. Pure functions, no I/O.
//
// The rule that keeps this safe: a failing check counts as "explained" only if swapping the changed piece of text in
// what the test expects gives something the workflow now really produces. A failure with any other cause is never
// touched, so this can never be used to quietly loosen a test.

const ASSERT_RE = /^(node "(.+)" (input|output)\.(\S+) )(==|contains) (.+)$/;
const parseVal = (s) => { try { return JSON.parse(s); } catch { return String(s).trim(); } };

// The smallest piece of text that differs between two values: what is left after the shared start and end are dropped.
export function segmentOf(from, to) {
  if (typeof from !== "string" || typeof to !== "string" || from === to) return null;
  let a = 0;
  while (a < from.length && a < to.length && from[a] === to[a]) a++;
  let b = 0;
  while (b < from.length - a && b < to.length - a && from[from.length - 1 - b] === to[to.length - 1 - b]) b++;
  const f = from.slice(a, from.length - b), t = to.slice(a, to.length - b);
  return f ? { from: f, to: t } : null;               // a pure insertion has nothing to find in an old expectation
}

// The text pieces that changed in an apply, from the saved description of its changes.
export function segmentsFromChanges(changes = []) {
  const out = [];
  for (const c of changes) {
    if (c.kind !== "changed") continue;
    for (const d of c.details ?? []) { const s = segmentOf(d.from, d.to); if (s) out.push(s); }
  }
  return out;
}

// Looks at one failed check. Either the exact new line for it, or why it is not ours to change.
export function explainCheck(check, segments) {
  const m = String(check.assertion).match(ASSERT_RE);
  if (!m) return { kind: "unexplained", reason: "not-text" };
  const [, head, , , , op, raw] = m;
  const detail = String(check.detail ?? "");
  const eq = detail.indexOf(" = ");
  let actual;
  try { actual = eq < 0 ? undefined : JSON.parse(detail.slice(eq + 3)); } catch { actual = undefined; }
  if (typeof actual !== "string") return { kind: "unexplained", reason: "no-actual" };
  const want = parseVal(raw);
  if (typeof want !== "string") return { kind: "unexplained", reason: "not-text" };
  let next = want;
  for (const s of segments) next = next.split(s.from).join(s.to);
  if (next === want) return { kind: "unexplained", reason: "unrelated" };       // none of the changed text appears in what it expects
  const passes = op === "contains" ? actual.includes(next) : actual === next;
  if (!passes) return { kind: "unexplained", reason: "mismatch" };               // swapping the text still does not give what happens
  const quoted = typeof parseVal(raw) === "string" && raw.trim().startsWith('"');
  return { kind: "explained", from: want, to: next, newAssertion: `${head}${op} ${quoted ? JSON.stringify(next) : next}` };
}

// Every failing test, sorted into the lines that can be updated and the failures that cannot.
export function planTestUpdates({ tests = [], changes = [] }) {
  const segments = segmentsFromChanges(changes);
  const updates = [], unexplained = [];
  for (const t of tests) {
    if (t.pass) continue;
    if (t.error) { unexplained.push({ file: t.file, test: t.name, reason: "error", error: t.error }); continue; }
    for (const c of t.checks ?? []) {
      if (c.pass) continue;
      const e = explainCheck(c, segments);
      if (e.kind === "explained") updates.push({ file: t.file, test: t.name, oldAssertion: c.assertion, newAssertion: e.newAssertion, from: e.from, to: e.to });
      else unexplained.push({ file: t.file, test: t.name, assertion: c.assertion, detail: c.detail, reason: e.reason });
    }
  }
  return { updates, unexplained, segments };
}

// Swaps assertion lines in the text of one test file, keeping everything else (comments, layout) exactly as it was.
// `replaceLine(text, old, next)` is injected so this module stays free of the YAML library.
export function rewriteTestText(text, edits, replaceLine) {
  let out = text;
  for (const e of edits) {
    const next = replaceLine(out, e.oldAssertion, e.newAssertion);
    if (next === null || next === out) return { error: `could not find: ${e.oldAssertion}` };
    out = next;
  }
  return { text: out };
}
