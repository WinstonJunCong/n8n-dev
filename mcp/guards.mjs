// Guard rails for the MCP server. Pure functions with injected clock and randomness, so every rule can be unit
// tested without Docker, a clock or a real client. Anything an assistant could abuse is checked here, in code,
// not left to instructions.
import { createHash, randomInt } from "node:crypto";

// A workflow is named by its folder. Only plain names are accepted: no slashes, dots, spaces or anything that
// could point outside the workflows folder.
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const isValidWorkflowName = (name) => typeof name === "string" && NAME.test(name);

// Returns { dir } with the workflow's folder relative to the repo root, or { error } with a plain message.
// `exists(relativePath)` is injected so this never touches the disk itself.
export function resolveWorkflow({ workflowsDir = "workflows", name, exists }) {
  if (!isValidWorkflowName(name)) {
    return { error: "A workflow name is only letters, numbers, dashes and underscores. Use list_workflows to see the valid names." };
  }
  const dir = `${workflowsDir.replace(/^\/+|\/+$/g, "")}/${name}`;
  if (!exists(`${dir}/workflow.json`)) return { error: `There is no workflow called "${name}". Use list_workflows to see the valid names.` };
  return { dir };
}

// The editor's port: a whole number in the range ordinary programs use, or the default.
export function pickPort(value, fallback = 5678) {
  if (value === undefined || value === null) return { port: fallback };
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return { error: "The port must be a whole number from 1024 to 65535." };
  return { port: n };
}

// Keeps a long command output from flooding the conversation: the start and the end are kept, since the result is
// usually at the end.
export function truncate(text, max = 20000) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4), tail = max - head;
  return `${s.slice(0, head)}\n\n[... ${s.length - max} characters left out ...]\n\n${s.slice(-tail)}`;
}

export const hashOf = (value) =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

// At most `max` uses in any `windowMs`. `take()` says whether this use is allowed and, if not, how long to wait.
export function makeRateLimiter({ max, windowMs, now = Date.now }) {
  let uses = [];
  return {
    take() {
      const t = now();
      uses = uses.filter((u) => t - u < windowMs);
      if (uses.length >= max) return { ok: false, retryInMs: windowMs - (t - uses[0]) };
      uses.push(t);
      return { ok: true };
    },
  };
}

// One-time codes: a preview issues one, and the action that follows must present it. That forces two separate,
// deliberate calls, so an action can never fire from a single call. A code works once, expires, is tied to what
// was previewed, and is dropped after too many wrong tries.
export function makeCodeStore({ ttlMs = 10 * 60 * 1000, maxTries = 3, now = Date.now, random = () => randomInt(100000, 1000000) } = {}) {
  const live = new Map();
  return {
    issue(subject) {
      for (const [code, v] of live) if (v.subject === subject) live.delete(code);   // a new preview replaces the old one
      const code = String(random());
      live.set(code, { subject, expires: now() + ttlMs, tries: 0 });
      return code;
    },
    // `subject` identifies what is being acted on (for example the workflow and a hash of its content).
    redeem(code, subject) {
      const v = live.get(String(code));
      if (!v) return { ok: false, reason: "That code is not valid. Preview again to get a new one." };
      if (now() > v.expires) { live.delete(String(code)); return { ok: false, reason: "That code has expired. Preview again to get a new one." }; }
      if (v.subject !== subject) {
        if (++v.tries >= maxTries) live.delete(String(code));
        return { ok: false, reason: "That code belongs to a different preview, or the content changed since. Preview again." };
      }
      live.delete(String(code));
      return { ok: true };
    },
  };
}

// Checks the arguments of a tool call against a small spec and rejects everything else: unknown keys, wrong types,
// missing required values, and anything that is not a plain object. `spec` maps each allowed key to
// { type: "string" | "any", required?: boolean }. Returns { value } (only the allowed keys) or { error }.
export function strictArgs(args, spec) {
  const given = args === undefined || args === null ? {} : args;
  if (typeof given !== "object" || Array.isArray(given)) return { error: "The arguments must be an object." };
  const allowed = new Set(Object.keys(spec));
  for (const key of Object.keys(given)) {
    if (!allowed.has(key)) return { error: `Unexpected argument "${key}". Allowed: ${[...allowed].join(", ") || "none"}.` };
  }
  const value = {};
  for (const [key, rule] of Object.entries(spec)) {
    const v = Object.prototype.hasOwnProperty.call(given, key) ? given[key] : undefined;
    if (v === undefined || v === null) {
      if (rule.required) return { error: `Missing required argument "${key}".` };
      continue;
    }
    if (rule.type === "string" && typeof v !== "string") return { error: `The argument "${key}" must be text.` };
    value[key] = v;
  }
  return { value };
}
