// The ONLY place in mcp/ that touches the disk or starts a process. Everything else receives these as plain
// functions, so the rules in guards.mjs and tools.mjs can be tested with fakes and nothing else can reach outside.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Read-only access to files inside the repository. Any path that resolves outside it is refused, even if a bug
// elsewhere let one through.
export function makeFs(root) {
  const base = path.resolve(root);
  const inside = (p) => {
    const abs = path.resolve(base, p);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`Refusing to touch a path outside the repository: ${p}`);
    return abs;
  };
  return {
    exists: (p) => fs.existsSync(inside(p)),
    readText: (p) => fs.readFileSync(inside(p), "utf8"),
    listDir: (p) => fs.readdirSync(inside(p), { withFileTypes: true })
      .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })),
  };
}

// Runs the n8n-dev command line with a fixed list of arguments. Never a shell, never a string to be split: each
// argument reaches the program exactly as given, so nothing in it can act as a command. Resolves to
// { status, out, timedOut }; it never rejects.
export function makeRunner({ root, nodePath = process.execPath, defaultTimeoutMs = 10 * 60 * 1000, maxOutput = 2_000_000 }) {
  const base = path.resolve(root);
  return function runCli(args, { timeoutMs = defaultTimeoutMs, env = {} } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(nodePath, [path.join(base, "harness", "n8n-dev.mjs"), ...args.map(String)], {
          cwd: base, shell: false, windowsHide: true,
          env: { ...process.env, ...env, MSYS_NO_PATHCONV: "1" },
        });
      } catch (e) { resolve({ status: null, out: `Could not start n8n-dev: ${e.message}`, timedOut: false }); return; }
      let out = "";
      const add = (d) => { out += d; if (out.length > maxOutput) out = out.slice(-maxOutput); };   // keep the end, where the result is
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      let done = false;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => { child.kill(); finish({ status: null, out: `${out}\n[stopped: it took longer than ${Math.round(timeoutMs / 1000)} seconds]`, timedOut: true }); }, timeoutMs);
      child.on("error", (e) => finish({ status: null, out: `Could not start n8n-dev: ${e.message}`, timedOut: false }));
      child.on("close", (code) => finish({ status: code, out, timedOut: false }));
    });
  };
}
