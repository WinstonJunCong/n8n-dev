// Tests for harness/testspec.mjs: every rule on turning a person's description into a test. No files, no Docker.
// Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { parseSpec, parseSpecs, validateSpec, commentLine, nextTestFile, specHash, LIMITS, parseAssertion, fieldExamples, describeTestObject } from "./testspec.mjs";

const STEPS = [
  { name: "Incoming", outside: false, trigger: true },
  { name: "Check site status", outside: true, trigger: false },
  { name: "Is site unhealthy?", outside: false, trigger: false },
  { name: "Send alert", outside: true, trigger: false },
  { name: "Ignore healthy site", outside: false, trigger: false },
];
const GOOD = () => ({
  name: "Down site sends an alert",
  when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "down", latency_ms: 1200 }] } },
  then: [
    { step: "Send alert", runs: 1 },
    { step: "Send alert", field: "text", contains: "docs is not healthy" },
    { step: "Ignore healthy site", doesNotRun: true },
    { endsAt: "Send alert" },
  ],
});
const check = (spec, existingNames = []) => validateSpec(spec, { steps: STEPS, existingNames });
const codes = (r) => r.errors.map((e) => e.code);

test("a good description becomes a test with fixed check phrases, and lists the outside steps left without an answer", () => {
  const r = check(GOOD());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.test, {
    test: "Down site sends an alert",
    trigger: { site: "docs" },
    mocks: { "Check site status": [{ status: "down", latency_ms: 1200 }] },
    assert: [
      'node "Send alert" called 1 time',
      'node "Send alert" input.text contains "docs is not healthy"',
      'node "Ignore healthy site" not called',
      'workflow ends at "Send alert"',
    ],
  });
  assert.deepEqual(r.unmocked, ["Send alert"]);
});

test("every kind of check has its own phrase: counts, not run, input and output fields, equals and not equals, ends at", () => {
  const spec = { name: "All the kinds", then: [
    { step: "Send alert", runs: 3 }, { step: "Send alert", doesNotRun: true },
    { step: "Send alert", side: "output", field: "reminder_count", is: 3 },
    { step: "Send alert", field: "ok", is: true },
    { step: "Send alert", field: "chat.id", isNot: "-100555" },
    { endsAt: "Ignore healthy site" },
  ] };
  const r = check(spec);
  assert.deepEqual(r.test.assert, [
    'node "Send alert" called 3 times', 'node "Send alert" not called', 'node "Send alert" output.reminder_count == 3',
    'node "Send alert" input.ok == true', 'node "Send alert" input.chat.id != "-100555"', 'workflow ends at "Ignore healthy site"',
  ]);
  assert.deepEqual(r.test.trigger, {});
  assert.equal("mocks" in r.test, false);
});

test("control: the good description fails when each part is broken, one at a time", () => {
  assert.equal(check(GOOD()).ok, true);
  const broken = [
    [(s) => { s.name = "ab"; }, "bad-name"],
    [(s) => { delete s.name; }, "bad-name"],
    [(s) => { s.when.services["Nowhere"] = [{}]; }, "unknown-step"],
    [(s) => { s.when.services["Is site unhealthy?"] = [{}]; }, "not-outside"],
    [(s) => { s.then = []; }, "empty-then"],
    [(s) => { delete s.then; }, "empty-then"],
    [(s) => { s.then[0].step = "Missing step"; }, "unknown-step"],
    [(s) => { s.then = Array.from({ length: 11 }, (_, i) => ({ step: "Send alert", runs: i + 1 })); }, "too-many-checks"],
    [(s) => { s.then.push({ step: "Send alert", runs: 1 }); }, "duplicate-check"],
    [(s) => { s.extra = 1; }, "unknown-field"],
    [(s) => { s.when.extra = 1; }, "bad-when"],
  ];
  for (const [mutate, code] of broken) {
    const spec = GOOD(); mutate(spec);
    assert.ok(codes(check(spec)).includes(code), `${code} for ${JSON.stringify(spec).slice(0, 80)}`);
  }
});

test("each malformed check is refused: wrong counts, wrong values, two operators, odd field names, odd sides", () => {
  for (const item of [
    { step: "Send alert", runs: 0 }, { step: "Send alert", runs: 100 }, { step: "Send alert", runs: 1.5 }, { step: "Send alert", runs: "1" },
    { step: "Send alert", doesNotRun: false }, { step: "Send alert", doesNotRun: true, runs: 1 },
    { step: "Send alert", field: "text" }, { step: "Send alert", field: "text", is: "a", contains: "b" },
    { step: "Send alert", field: "bad field", is: "a" }, { step: "Send alert", field: "a..b", is: "a" }, { step: "Send alert", field: "", is: "a" },
    { step: "Send alert", field: "a;b", is: "a" }, { step: "Send alert", side: "sideways", field: "a", is: "a" },
    { step: "Send alert", field: "a", is: "" }, { step: "Send alert", field: "a", is: "x".repeat(LIMITS.value + 1) },
    { step: "Send alert", field: "a", is: { nested: true } }, { step: "Send alert", field: "a", is: null },
    { step: "Send alert", field: "a", contains: 5 }, { step: "Send alert", field: "a", is: "line\nbreak" },
    { step: "Send alert", field: "a", is: Infinity }, { step: "Send alert", field: "a", is: "ok", unknown: 1 },
    { endsAt: "Send alert", runs: 1 }, { endsAt: 5 }, "a string", null, 5, { step: 5, runs: 1 },
  ]) {
    const r = check({ name: "Valid name", then: [item] });
    assert.equal(r.ok, false, JSON.stringify(item));
  }
});

test("step names that could break out of a check line are refused", () => {
  for (const bad of ['Send "alert"', "Send\nalert", "__test_start__"]) {
    const steps = [...STEPS, { name: bad, outside: false, trigger: false }];
    const r = validateSpec({ name: "Valid name", then: [{ step: bad, runs: 1 }] }, { steps });
    assert.deepEqual(r.errors.map((e) => e.code), ["step-name-unsupported"], bad);
  }
});

test("a value can hold quotes, hashes and colons without becoming anything but a value", () => {
  const value = 'He said "hi" # not a comment: - node "Evil" called 9 times';
  const r = check({ name: "Valid name", then: [{ step: "Send alert", field: "text", contains: value }] });
  assert.equal(r.ok, true);
  assert.equal(r.test.assert.length, 1);
  assert.equal(JSON.parse(r.test.assert[0].split(" contains ")[1]), value);
});

test("the starting event and the pretend answers must be plain, small data", () => {
  const withTrigger = (trigger) => check({ ...GOOD(), when: { trigger } });
  assert.equal(withTrigger({ a: 1, b: { c: [1, 2, { d: "x" }] } }).ok, true);
  for (const bad of ["text", [1], { "": 1 }, { ["x".repeat(61)]: 1 }, { a: undefined }, { a: () => 1 }, { a: Infinity }, { "line\nbreak": 1 },
    JSON.parse('{"__proto__": {"polluted": true}}'), { a: { b: { c: { d: { e: 1 } } } } }, { big: "x".repeat(LIMITS.triggerChars) }]) {
    assert.ok(codes(withTrigger(bad)).includes("bad-trigger"), JSON.stringify(bad)?.slice(0, 60));
  }
  const rows = (r) => check({ ...GOOD(), when: { services: { "Check site status": r } } });
  assert.equal(rows([{ a: 1 }]).ok, true);
  for (const bad of [[], "x", [1], [{ a: undefined }], Array.from({ length: LIMITS.rows + 1 }, () => ({}))]) assert.ok(codes(rows(bad)).includes("bad-services"), JSON.stringify(bad)?.slice(0, 40));
});

test("a name already used by another test is refused, ignoring case and spaces", () => {
  assert.deepEqual(codes(check(GOOD(), ["down site sends an ALERT "])), ["name-taken"]);
  assert.equal(check(GOOD(), ["Something else"]).ok, true);
});

test("the description is read from text safely: bad JSON, oversize, and non-objects are refused", () => {
  assert.deepEqual(parseSpec(JSON.stringify(GOOD())).spec.name, "Down site sends an alert");
  for (const bad of ["", "   ", "{nope", "[]", "5", "null", '"text"', undefined, 5]) assert.equal(parseSpec(bad).error.code, "bad-json", String(bad));
  assert.equal(parseSpec(JSON.stringify({ name: "x".repeat(LIMITS.specChars) })).error.code, "too-big");
});

test("the person's words become one safe comment line", () => {
  assert.equal(commentLine('Down  sites\nshould\r\nsend an alert'), "Down sites should send an alert");
  assert.equal(commentLine("a\u0000b\u001fc"), "a b c");
  assert.equal(commentLine("x".repeat(LIMITS.words + 50)).length, LIMITS.words);
  assert.equal(commentLine(undefined), "");
});

test("file names carry the next number and the name in plain letters, and never reuse one", () => {
  assert.equal(nextTestFile([], "Down site sends an alert"), "01-down-site-sends-an-alert.yaml");
  assert.equal(nextTestFile(["01-a.yaml", "02-b.yaml", "07-c.yaml"], "New one!"), "08-new-one.yaml");
  assert.equal(nextTestFile(["01-x.yaml"], "???"), "02-test.yaml");
  assert.equal(nextTestFile([], "../../etc/passwd"), "01-etc-passwd.yaml");
  assert.equal(nextTestFile([], "x".repeat(100)).length, "01-".length + 40 + ".yaml".length);
  assert.ok(!nextTestFile(["01-a.yaml", "02-a.yaml"], "a").includes("/"));
  // never a name that exists, whatever the existing names look like
  for (const existing of [[], ["01-a.yaml"], ["03-a.yaml", "01-a.yaml"], ["a.yaml", "notes.yaml"], ["99-a.yaml"], ["07-test.yaml", "08-test.yaml"]]) {
    const next = nextTestFile(existing, "a");
    assert.ok(!existing.includes(next), `${next} already exists among ${existing}`);
  }
  assert.equal(nextTestFile(["99-a.yaml"], "a"), "100-a.yaml");
});

test("the same description and words always give the same fingerprint, and any change gives a different one", () => {
  assert.equal(specHash(GOOD(), "words"), specHash(GOOD(), "words"));
  const other = GOOD(); other.then[0].runs = 2;
  assert.notEqual(specHash(GOOD(), "words"), specHash(other, "words"));
  assert.notEqual(specHash(GOOD(), "words"), specHash(GOOD(), "other words"));
});

test("a request can be one test or a small list of them, and anything else is refused", () => {
  const one = { name: "One test" }, two = { name: "Two test" };
  assert.deepEqual(parseSpecs(JSON.stringify(one)).specs, [one]);
  assert.deepEqual(parseSpecs(JSON.stringify([one, two])).specs, [one, two]);
  for (const bad of ["", "   ", "{nope", "[]", "5", "null", '"text"', "[1]", '[{"a":1}, "x"]', "[[{}]]", undefined, 5]) assert.equal(parseSpecs(bad).error?.code, "bad-json", String(bad));
  const six = Array.from({ length: LIMITS.testsPerPreview }, (_, i) => ({ name: `T${i}` }));
  assert.equal(parseSpecs(JSON.stringify(six)).specs.length, LIMITS.testsPerPreview);
  assert.equal(parseSpecs(JSON.stringify([...six, one])).error.code, "too-many-in-preview");
  assert.equal(parseSpecs(JSON.stringify([{ name: "x".repeat(LIMITS.specChars) }])).error.code, "too-big");
  assert.equal(LIMITS.testsPerPreview, 6);
});

// ---------- reading existing tests back ----------
test("each check phrase is read back into the same form a description uses", () => {
  assert.deepEqual(parseAssertion('node "Send alert" called 1 time'), { step: "Send alert", runs: 1 });
  assert.deepEqual(parseAssertion('node "Send alert" called 3 times'), { step: "Send alert", runs: 3 });
  assert.deepEqual(parseAssertion('node "Ignore healthy site" not called'), { step: "Ignore healthy site", doesNotRun: true });
  assert.deepEqual(parseAssertion('node "Compose" input.text contains "ALERT: docs"'), { step: "Compose", field: "text", contains: "ALERT: docs" });
  assert.deepEqual(parseAssertion('node "Compose" output.reminder_count == 3'), { step: "Compose", side: "output", field: "reminder_count", is: 3 });
  assert.deepEqual(parseAssertion('node "Send" input.chat_id != "-100555"'), { step: "Send", field: "chat_id", isNot: "-100555" });
  assert.deepEqual(parseAssertion('workflow ends at "Send alert"'), { endsAt: "Send alert" });
  assert.deepEqual(parseAssertion("something the runner does not understand"), { raw: "something the runner does not understand" });
  assert.deepEqual(parseAssertion('node "S" input.text contains plain words'), { step: "S", field: "text", contains: "plain words" }, "an unquoted value is kept as text");
});

test("control: what a description writes, reading it back gives the same description", () => {
  const spec = GOOD();
  spec.then.push({ step: "Send alert", side: "output", field: "a.b", isNot: 3 }, { step: "Send alert", field: "ok", is: true });
  const written = check(spec);
  assert.equal(written.ok, true, JSON.stringify(written.errors));
  assert.deepEqual(written.test.assert.map(parseAssertion), spec.then, "every line reads back as the item it came from");
});

test("field names and an example value are taken from the rows, first seen wins, and odd rows are skipped", () => {
  assert.deepEqual(fieldExamples([{ status: "down", latency_ms: 1200 }, { status: "up", extra: true }, null, "x", [1]]), { status: "down", latency_ms: 1200, extra: true });
  assert.deepEqual(fieldExamples([]), {});
});

test("a test file is described the way an assistant would write it, and an odd file is not", () => {
  const obj = { test: "Down site", trigger: { site: "docs" }, mocks: { "Check site status": [{ status: "down" }] }, assert: ['node "Send alert" called 1 time', "odd"] };
  assert.deepEqual(describeTestObject(obj), { name: "Down site", when: { trigger: { site: "docs" }, services: { "Check site status": [{ status: "down" }] } }, then: [{ step: "Send alert", runs: 1 }, { raw: "odd" }] });
  assert.deepEqual(describeTestObject({ test: "Bare" }), { name: "Bare", when: { trigger: {}, services: {} }, then: [] });
  for (const bad of [null, "text", [1], 5, undefined]) assert.equal(describeTestObject(bad), null, String(bad));
});
