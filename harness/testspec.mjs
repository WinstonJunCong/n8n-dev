// Turns a description of what a person wants ("when this happens, this should happen") into a test file, safely.
// Pure functions: no files, no Docker. The description is structured data, never free text, and every check line is built
// here from fixed phrases, so nothing a caller writes can end up as something else inside a test file.
//
// A description looks like:
//   { "name": "Down site sends an alert",
//     "when": { "trigger": { "site": "docs" },                       // the starting event
//               "services": { "Check site status": [ { "status": "down" } ] } },   // pretend answers of outside steps
//     "then": [ { "step": "Send alert", "runs": 1 },
//               { "step": "Send alert", "field": "text", "contains": "docs is not healthy" },
//               { "step": "Ignore healthy site", "doesNotRun": true },
//               { "endsAt": "Send alert" } ] }
import { createHash } from "node:crypto";

export const LIMITS = { name: 80, words: 500, specChars: 8000, checks: 10, rows: 10, tests: 30, triggerChars: 2000, value: 300, depth: 4 };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const FIELD_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const plainText = (s) => typeof s === "string" && !/[\u0000-\u001f\u007f]/.test(s);

export const specHash = (spec, words) => createHash("sha256").update(JSON.stringify([spec, words])).digest("hex");

export function parseSpec(text) {
  if (typeof text !== "string" || !text.trim()) return { error: { code: "bad-json" } };
  if (text.length > LIMITS.specChars) return { error: { code: "too-big" } };
  try {
    const spec = JSON.parse(text);
    return isObj(spec) ? { spec } : { error: { code: "bad-json" } };
  } catch { return { error: { code: "bad-json" } }; }
}

// Plain JSON data only, shallow, with ordinary keys: it goes into a file and into a fake event.
function plainData(value, depth = 0) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return typeof value !== "number" || Number.isFinite(value);
  if (depth >= LIMITS.depth) return false;
  if (Array.isArray(value)) return value.length <= 50 && value.every((v) => plainData(v, depth + 1));
  if (isObj(value)) {
    return Object.keys(value).length <= 50 && Object.entries(value).every(([k, v]) =>
      k.length > 0 && k.length <= 60 && plainText(k) && !["__proto__", "constructor", "prototype"].includes(k) && plainData(v, depth + 1));
  }
  return false;
}

const onlyKeys = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));

// steps          the workflow's steps: [{ name, outside, trigger }]
// existingNames  names of the tests it already has
export function validateSpec(spec, { steps, existingNames = [] }) {
  const errors = [];
  const add = (code, extra = {}) => errors.push({ code, ...extra });
  const names = steps.map((s) => s.name);
  const stepOk = (name, where) => {
    if (typeof name !== "string" || !name) { add("bad-then", { where }); return false; }
    if (/["\n\r]/.test(name) || name === "__test_start__") { add("step-name-unsupported", { step: name }); return false; }
    if (!names.includes(name)) { add("unknown-step", { step: name, steps: names.filter((n) => !n.startsWith("__")) }); return false; }
    return true;
  };

  if (!onlyKeys(spec, ["name", "when", "then"])) add("unknown-field", { fields: Object.keys(spec).filter((k) => !["name", "when", "then"].includes(k)) });
  const name = typeof spec.name === "string" ? spec.name.trim() : "";
  if (name.length < 3 || name.length > LIMITS.name || !plainText(name)) add("bad-name");
  else if (existingNames.some((n) => String(n).trim().toLowerCase() === name.toLowerCase())) add("name-taken", { name });

  const when = spec.when ?? {};
  let trigger = {}, services = {};
  if (!isObj(when) || !onlyKeys(when, ["trigger", "services"])) add("bad-when");
  else {
    if (when.trigger !== undefined) {
      if (!isObj(when.trigger) || !plainData(when.trigger) || JSON.stringify(when.trigger).length > LIMITS.triggerChars) add("bad-trigger");
      else trigger = when.trigger;
    }
    if (when.services !== undefined) {
      if (!isObj(when.services)) add("bad-services");
      else {
        for (const [step, rows] of Object.entries(when.services)) {
          const known = steps.find((s) => s.name === step);
          if (!known) { add("unknown-step", { step, steps: names.filter((n) => !n.startsWith("__")) }); continue; }
          if (!known.outside) { add("not-outside", { step, outside: steps.filter((s) => s.outside).map((s) => s.name) }); continue; }
          if (!Array.isArray(rows) || rows.length < 1 || rows.length > LIMITS.rows || !rows.every((r) => isObj(r) && plainData(r))) { add("bad-services", { step }); continue; }
          services[step] = rows;
        }
      }
    }
  }

  const then = spec.then;
  const assertions = [];
  if (!Array.isArray(then) || then.length === 0) add("empty-then");
  else if (then.length > LIMITS.checks) add("too-many-checks", { max: LIMITS.checks });
  else {
    for (const item of then) {
      if (!isObj(item)) { add("bad-then"); continue; }
      if ("endsAt" in item) {
        if (!onlyKeys(item, ["endsAt"])) add("bad-then");
        else if (stepOk(item.endsAt, "endsAt")) assertions.push(`workflow ends at "${item.endsAt}"`);
        continue;
      }
      if (!stepOk(item.step, "step")) continue;
      if ("runs" in item) {
        if (!onlyKeys(item, ["step", "runs"]) || !Number.isInteger(item.runs) || item.runs < 1 || item.runs > 99) add("bad-then", { step: item.step });
        else assertions.push(`node "${item.step}" called ${item.runs} time${item.runs === 1 ? "" : "s"}`);
      } else if ("doesNotRun" in item) {
        if (!onlyKeys(item, ["step", "doesNotRun"]) || item.doesNotRun !== true) add("bad-then", { step: item.step });
        else assertions.push(`node "${item.step}" not called`);
      } else {
        const ops = ["is", "contains", "isNot"].filter((o) => o in item);
        const side = item.side ?? "input";
        const value = ops.length === 1 ? item[ops[0]] : undefined;
        const valueOk = (typeof value === "string" && value.length >= 1 && value.length <= LIMITS.value && plainText(value))
          || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
        if (ops.length !== 1 || !onlyKeys(item, ["step", "side", "field", ...ops]) || !["input", "output"].includes(side)
          || typeof item.field !== "string" || !FIELD_RE.test(item.field) || item.field.length > 80 || !valueOk
          || (ops[0] === "contains" && typeof value !== "string")) add("bad-then", { step: item.step });
        else assertions.push(`node "${item.step}" ${side}.${item.field} ${{ is: "==", contains: "contains", isNot: "!=" }[ops[0]]} ${JSON.stringify(value)}`);
      }
    }
    if (new Set(assertions).size !== assertions.length) add("duplicate-check");
  }
  if (errors.length) return { ok: false, errors };
  const unmocked = steps.filter((s) => s.outside && !(s.name in services)).map((s) => s.name);
  return { ok: true, test: { test: name, trigger, ...(Object.keys(services).length ? { mocks: services } : {}), assert: assertions }, unmocked };
}

// The person's own words as one safe comment line.
export function commentLine(words) {
  return String(words ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LIMITS.words);
}

// 01-down-site-sends-an-alert.yaml: the next number, and the name in plain letters.
// The number is always one above every number already in use, so the name can never be one that exists.
export function nextTestFile(existingFiles, name) {
  const top = existingFiles.map((f) => Number(/^(\d+)-/.exec(f)?.[1])).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0);
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "test";
  return `${String(top + 1).padStart(2, "0")}-${slug}.yaml`;
}
