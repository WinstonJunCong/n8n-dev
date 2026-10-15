// n8n-dev init <target-dir> [--workflows-dir workflows] [--n8n-version 2.43.4] [--live-host n8n.example.com] [--approver "Name"]
// Scaffolds a ready-to-use governed-dev repo for any company: harness, Docker script, config, CI, PR template, CLAUDE.md.
// Never overwrites: if any file it would create already exists, it stops and changes nothing.
import fs from "node:fs";
import path from "node:path";

const flagOf = (args, name, fallback) => { const i = args.indexOf(name); return i > -1 && args[i + 1] ? args[i + 1] : fallback; };

export function init(root, args) {
  const target = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
  if (!target) { console.log('usage: n8n-dev init <target-dir> [--workflows-dir workflows] [--n8n-version 2.43.4] [--live-host n8n.example.com] [--approver "Name"]'); process.exit(2); }
  const dir = flagOf(args, "--workflows-dir", "workflows").replace(/^\/+|\/+$/g, "");
  const version = flagOf(args, "--n8n-version", "2.43.4");
  const liveHost = flagOf(args, "--live-host", "n8n.your-company.example");
  const approver = flagOf(args, "--approver", "the approver");

  const example = JSON.parse(fs.readFileSync(path.join(root, "config/readiness.example.json"), "utf8"));
  const config = { ...example, n8nVersion: version, workflowsDir: dir, liveN8nHosts: [liveHost] };
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.name = path.basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "n8n-governed-dev";

  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  lock.name = pkg.name;
  if (lock.packages?.[""]) lock.packages[""].name = pkg.name;

  const files = {
    "package-lock.json": JSON.stringify(lock, null, 2) + "\n",
    "config/readiness.json": JSON.stringify(config, null, 2) + "\n",
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    "harness/n8n-dev.mjs": fs.readFileSync(path.join(root, "harness/n8n-dev.mjs"), "utf8"),
    "harness/changed.mjs": fs.readFileSync(path.join(root, "harness/changed.mjs"), "utf8"),
    "harness/init.mjs": fs.readFileSync(path.join(root, "harness/init.mjs"), "utf8"),
    "scripts/n8n-docker.sh": fs.readFileSync(path.join(root, "scripts/n8n-docker.sh"), "utf8").replace(/2\.43\.4/g, version),
    ...sampleWorkflow(root, dir),
    ".gitignore": "node_modules/\n.n8n-dev/\n",
    ".github/workflows/ci.yml": ci(version),
    ".github/pull_request_template.md": prTemplate(),
    "CLAUDE.md": claudeMd(dir, approver, liveHost),
  };

  const clash = Object.keys(files).filter((f) => fs.existsSync(path.join(target, f)));
  if (clash.length) { console.log(`Nothing written. These files already exist in ${target}:\n- ${clash.join("\n- ")}`); process.exit(1); }
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(target, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  console.log(`Created ${Object.keys(files).length} files in ${target}\n\nNext:\n  1. cd ${target} && npm install\n  2. Edit config/readiness.json (hosts, secret rules, outside node types)\n  3. Try the sample: N8N_CMD=./scripts/n8n-docker.sh node harness/n8n-dev.mjs check ${dir}/site-health-alert\n  4. Put each of your workflows in ${dir}/<name>/workflow.json with tests in tests/*.yaml\n  5. Turn on "Require status checks" for main in GitHub settings`);
}

// The generic sample (workflow.json + tests/*.yaml), so a new repo passes `check` straight away.
// Falls back to an empty folder marker if this copy of the harness has no sample.
function sampleWorkflow(root, dir) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config/readiness.json"), "utf8"));
  const src = path.join(root, config.workflowsDir || "workflows", "site-health-alert");
  if (!fs.existsSync(path.join(src, "workflow.json"))) return { [`${dir}/.gitkeep`]: "" };
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out[`${dir}/site-health-alert/${r}`] = fs.readFileSync(path.join(src, r), "utf8");
    }
  };
  walk("");
  return out;
}

const ci = (version) => `# CI: runs on every pull request. A red check blocks the merge.
name: n8n checks
on:
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # full history, so we can see what this pull request changed
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Reuse the n8n node list from earlier runs
        uses: actions/cache@v4
        with:
          path: .n8n-dev/nodes-${version}.json
          key: n8n-nodes-${version}
      - run: docker pull -q n8nio/n8n:${version}
      - name: Readiness scan, structure check and fake tests (changed workflows + their callers)
        env:
          N8N_CMD: bash ./scripts/n8n-docker.sh
        run: |
          status=0
          dirs=$(node harness/changed.mjs "origin/\${{ github.base_ref }}")
          if [ -z "$dirs" ]; then echo "No workflows affected by this change." | tee -a "$GITHUB_STEP_SUMMARY"; exit 0; fi
          for d in $dirs; do
            n=$(basename "$d")
            node harness/n8n-dev.mjs check "$d" --report "reports/$n.md" || status=1
            cat "reports/$n.md" >> "$GITHUB_STEP_SUMMARY"
          done
          exit $status
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: n8n-dev-reports, path: reports/ }
`;

const prTemplate = () => `## What changed
<!-- One workflow change and its tests, or one harness change. Not both. -->

## Checks
- [ ] \`check\` passes locally
- [ ] New or fixed behaviour has a test that would have caught the bug
- [ ] No keys, IDs or addresses typed into nodes
`;

const claudeMd = (dir, approver, liveHost) => `# n8n governed dev: project notes for Claude Code

## What this is
Nobody edits live n8n directly. Changes are made in a copy, checked by the \`n8n-dev\` harness, reviewed in a pull request, and only then deployed.

## Layout
- \`${dir}/<name>/workflow.json\` + \`${dir}/<name>/tests/*.yaml\`: one folder per workflow
- \`harness/n8n-dev.mjs\`: scan | structure | test | check | init
- \`config/readiness.json\`: allowed hosts, live n8n hosts, secret rules, which node types count as "outside" steps

## Commands
\`\`\`bash
N8N_CMD=./scripts/n8n-docker.sh node harness/n8n-dev.mjs check ${dir}/<name> --report reports/<name>.md
\`\`\`

## Rules for Claude in this repo
- Never use real credentials, never call live n8n (\`${liveHost}\`), never type IDs/keys/URLs into workflows.
- Never commit or push to \`main\`. Work on a branch, run \`check\` locally, open a pull request, wait for green CI.
- Never merge a pull request with a red check. Merging is ${approver}'s job.
- Do not weaken tests, \`config/\`, \`harness/\` or CI to make a check pass; flag it to the approver instead.
- Keep pull requests small: one workflow change + its tests, or one harness change, not both.
- Every bug fix adds a test that would have caught it.
- After running \`ui\` (the sealed n8n editor), confirm it cleaned up: \`bash ./scripts/n8n-chamber.sh status\` must print CLEAN (exit 0). If it prints LEFTOVERS, run \`bash ./scripts/n8n-chamber.sh down\` and check again.
`;
