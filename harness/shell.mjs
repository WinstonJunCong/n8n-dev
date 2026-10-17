// Finds Git Bash on Windows. Pure: the caller hands in the environment, a file check and where Git lives, so every
// rule is testable on any machine.
//
// Why this exists: the scripts here are bash scripts. On Windows the plain name `bash` is usually WSL's Linux shell
// (C:\Windows\System32\bash.exe), not Git Bash, and Git Bash is only on the path inside a Git Bash window. A program
// started by an app (an AI assistant, for example) does not inherit that path, so `bash` silently meant WSL, where the
// Docker volume paths and users differ and the checks failed in confusing ways. So Git Bash is found by where Git
// is installed, and WSL's bash is never used.
import { win32 } from "node:path";

const ROOT_SUFFIXES = [/\\cmd\\git\.exe$/i, /\\mingw(?:32|64)\\bin\\git\.exe$/i, /\\bin\\git\.exe$/i, /\\usr\\bin\\git\.exe$/i];
const isWsl = (p) => /\\windows\\(?:system32|sysnative|syswow64)\\bash\.exe$/i.test(p);

// The Git for Windows folder a git.exe belongs to, or null if the path does not look like one.
export function gitRootOf(gitExe) {
  const p = win32.normalize(String(gitExe).trim());
  for (const suffix of ROOT_SUFFIXES) if (suffix.test(p)) return p.replace(suffix, "");
  return null;
}

// Returns { shell } (a path to bash.exe, or `true` for the platform's normal shell) or { error }.
//   env       the process environment
//   exists    (path) => boolean
//   gitPaths  full paths of git.exe as found on the PATH (may be empty)
export function findBash({ platform, env = {}, exists, gitPaths = [] }) {
  if (platform !== "win32") return { shell: true };
  const roots = [];
  const add = (r) => { if (r && !roots.includes(r)) roots.push(r); };
  for (const g of gitPaths) add(gitRootOf(g));
  add(env.GIT_INSTALL_ROOT);
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]) if (base) add(win32.join(base, "Git"));
  if (env.LOCALAPPDATA) add(win32.join(env.LOCALAPPDATA, "Programs", "Git"));
  for (const drive of "CDEFGHIJ") add(`${drive}:\\Program Files\\Git`);

  const candidates = [];
  if (env.EXEPATH) candidates.push(win32.join(env.EXEPATH, "bash.exe"));          // set inside Git Bash windows
  for (const r of roots) candidates.push(win32.join(r, "bin", "bash.exe"), win32.join(r, "usr", "bin", "bash.exe"));

  const found = candidates.find((c) => !isWsl(c) && exists(c));
  if (found) return { shell: found };
  return {
    error: "Git Bash was not found. These scripts need it on Windows, and the plain `bash` command is WSL's Linux shell, " +
      "which is not used. Install Git for Windows (https://git-scm.com/download/win), or start this from a Git Bash window.",
  };
}
