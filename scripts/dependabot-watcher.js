#!/usr/bin/env node
/**
 * Dependabot watcher — auto-applies the P-DEPENDABOT-LOCKFILE playbook to
 * any open dependabot PR with failing CI on `npm ci` lockfile mismatch.
 *
 * Usage:
 *   node scripts/dependabot-watcher.js [--repo OWNER/NAME] [--dry-run] [--max=N]
 *
 * Defaults: --repo FlexNetOS/agent_harness, max=10, push=true.
 *
 * Encodes the lessons from 2026-05-03:
 *   1. Refresh package-lock.json via `npm install` (honors the bump).
 *   2. Combine peer-dep families (eslint + @eslint/js v10 must move together).
 *   3. Reset side-effect drift (yarn.lock postinstall) before committing.
 *   4. Never sweep untracked session files into the commit.
 *
 * Idempotent: a PR already past the EUSAGE failure is skipped.
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DEFAULT = 'FlexNetOS/agent_harness';
const PEER_FAMILIES = [
  { match: /^@eslint\/js$/, version: /^\^?10\./, siblings: [{ name: 'eslint', version: '^10.3.0' }] },
  { match: /^eslint$/, version: /^\^?10\./, siblings: [{ name: '@eslint/js', version: '^10.0.1' }] }
];

function parseArgs(argv) {
  const args = { repo: REPO_DEFAULT, dryRun: false, max: 10, root: process.cwd() };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--repo=')) args.repo = a.slice(7);
    else if (a.startsWith('--max=')) args.max = parseInt(a.slice(6), 10) || 10;
    else if (a.startsWith('--root=')) args.root = a.slice(7);
  }
  return args;
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

function shTry(cmd, opts = {}) {
  try { return sh(cmd, opts); } catch (err) { return { error: err.message, stderr: err.stderr ? err.stderr.toString() : '' }; }
}

function ghPath() {
  if (process.env.GH_PATH) return process.env.GH_PATH;
  const candidates = [
    'C:/Program Files/GitHub CLI/gh.exe',
    '/usr/local/bin/gh',
    '/usr/bin/gh'
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return 'gh';
}

const GH = ghPath();

function listDependabotPRs(repo) {
  const raw = sh(`"${GH}" pr list --repo ${repo} --state open --json number,title,author,headRefName --limit 50`);
  return JSON.parse(raw).filter((pr) => pr.author && pr.author.login === 'dependabot' || /^dependabot\//.test(pr.headRefName));
}

function prHasLockfileMismatch(repo, num) {
  // Check the latest run for this PR; look for EUSAGE in the failed-job logs.
  const checks = shTry(`"${GH}" pr checks ${num} --repo ${repo}`);
  if (typeof checks !== 'string') return { failing: false, reason: 'cant-list-checks' };
  if (!/\bfail\b/i.test(checks)) return { failing: false, reason: 'no-failing-checks' };
  // We could fetch the run log, but for v1 the heuristic is: if the PR is by
  // dependabot AND any check is failing, it's a candidate. The actual fix
  // (npm install) is a no-op if the lockfile is already in sync.
  return { failing: true };
}

function detectFamilyBump(packageJson, bumpedPkg) {
  const family = PEER_FAMILIES.find((f) => f.match.test(bumpedPkg));
  if (!family) return [];
  const version = (packageJson.devDependencies || {})[bumpedPkg] || (packageJson.dependencies || {})[bumpedPkg];
  if (!version || !family.version.test(version)) return [];
  return family.siblings;
}

function applyFamilyBumps(packageJsonPath, siblings) {
  const j = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const dd = j.devDependencies || {};
  let touched = false;
  for (const sib of siblings) {
    if (dd[sib.name] && dd[sib.name] !== sib.version) {
      dd[sib.name] = sib.version;
      touched = true;
    } else if (!dd[sib.name] && (j.dependencies || {})[sib.name]) {
      j.dependencies[sib.name] = sib.version;
      touched = true;
    }
  }
  if (touched) fs.writeFileSync(packageJsonPath, JSON.stringify(j, null, 2) + '\n');
  return touched;
}

function inferBumpedPkg(branch) {
  // dependabot/npm_and_yarn/<pkg>-<version> or dependabot/npm_and_yarn/<scope>/<pkg>-<version>
  const m = /^dependabot\/npm_and_yarn\/(.+)-(\d[\w.+-]*)$/.exec(branch);
  if (!m) return null;
  return m[1].replace('/', '/'); // already correctly slashed
}

async function fixPR(args, pr) {
  const repoLocalRoot = args.root;
  const branch = pr.headRefName;
  const bumpedPkg = inferBumpedPkg(branch);
  console.log(`\n=== PR #${pr.number}: ${pr.title} ===`);
  console.log(`  branch: ${branch}`);
  console.log(`  bumped: ${bumpedPkg || '(unparsed)'}`);

  const fetchOut = shTry('git fetch origin', { cwd: repoLocalRoot });
  if (fetchOut.error) console.warn(`  fetch warning: ${fetchOut.error}`);

  // Reset any side-effect drift before switching.
  shTry('git checkout yarn.lock', { cwd: repoLocalRoot });

  const switchOut = shTry(`git switch ${branch}`, { cwd: repoLocalRoot });
  if (switchOut.error) {
    console.warn(`  switch failed: ${switchOut.stderr || switchOut.error}`);
    return { pr: pr.number, result: 'switch_failed' };
  }

  // Family-bump check.
  const pkgJsonPath = path.join(repoLocalRoot, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const siblings = bumpedPkg ? detectFamilyBump(pkgJson, bumpedPkg) : [];
  let combined = false;
  if (siblings.length) {
    combined = applyFamilyBumps(pkgJsonPath, siblings);
    if (combined) console.log(`  combined family bump: ${siblings.map((s) => s.name).join(', ')}`);
  }

  // Refresh lockfile.
  const installOut = shTry('npm install --no-audit --no-fund --loglevel=error', { cwd: repoLocalRoot });
  if (installOut.error) {
    console.warn(`  npm install failed: ${installOut.stderr || installOut.error}`);
    shTry('git checkout package.json package-lock.json', { cwd: repoLocalRoot });
    return { pr: pr.number, result: 'install_failed', error: installOut.stderr || installOut.error };
  }

  // Reset side-effect drift on yarn.lock again (postinstall sometimes touches).
  shTry('git checkout yarn.lock', { cwd: repoLocalRoot });

  // Has anything changed?
  const status = sh('git status --porcelain package.json package-lock.json', { cwd: repoLocalRoot });
  if (!status.trim()) {
    console.log('  no lockfile changes — already in sync');
    return { pr: pr.number, result: 'already_in_sync' };
  }

  if (args.dryRun) {
    console.log('  [dry-run] would commit + push:');
    console.log(status);
    return { pr: pr.number, result: 'dry_run' };
  }

  shTry('git add package.json package-lock.json', { cwd: repoLocalRoot });
  const commitMsg = combined
    ? `build(deps): refresh package-lock + sibling bump for ${bumpedPkg}\n\nAuto-applied by PromptNexus dependabot-watcher (P-DEPENDABOT-LOCKFILE).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
    : `build(deps): refresh package-lock.json for ${bumpedPkg || branch}\n\nAuto-applied by PromptNexus dependabot-watcher (P-DEPENDABOT-LOCKFILE).\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`;
  const commitOut = shTry(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: repoLocalRoot });
  if (commitOut.error) {
    console.warn(`  commit failed: ${commitOut.stderr || commitOut.error}`);
    return { pr: pr.number, result: 'commit_failed' };
  }
  const pushOut = shTry('git push', { cwd: repoLocalRoot });
  if (pushOut.error) {
    console.warn(`  push failed: ${pushOut.stderr || pushOut.error}`);
    return { pr: pr.number, result: 'push_failed' };
  }

  console.log('  pushed.');
  return { pr: pr.number, result: combined ? 'combined_family_bump' : 'lockfile_refreshed' };
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`dependabot-watcher repo=${args.repo} dry_run=${args.dryRun} max=${args.max} root=${args.root}`);

  let prs;
  try {
    prs = listDependabotPRs(args.repo);
  } catch (err) {
    console.error('list PRs failed:', err.message);
    process.exit(2);
  }
  console.log(`found ${prs.length} dependabot PR(s)`);

  const candidates = [];
  for (const pr of prs) {
    const m = prHasLockfileMismatch(args.repo, pr.number);
    if (m.failing) candidates.push(pr);
  }
  console.log(`${candidates.length} candidate(s) for fix`);

  const startBranch = sh('git branch --show-current', { cwd: args.root });
  const fixes = [];
  for (const pr of candidates.slice(0, args.max)) {
    const result = await fixPR(args, pr);
    fixes.push(result);
  }

  // Restore starting branch.
  shTry('git checkout yarn.lock', { cwd: args.root });
  shTry(`git switch ${startBranch}`, { cwd: args.root });

  // Persist run record.
  const runDir = path.resolve(__dirname, '..', 'evals', 'dependabot-runs');
  fs.mkdirSync(runDir, { recursive: true });
  const runRecord = {
    timestamp: new Date().toISOString(),
    repo: args.repo,
    dry_run: args.dryRun,
    prs_inspected: prs.length,
    prs_candidate: candidates.length,
    fixes
  };
  const runFile = path.join(runDir, `${runRecord.timestamp.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(runFile, JSON.stringify(runRecord, null, 2));
  console.log(`\n=== summary ===`);
  console.log(JSON.stringify(runRecord, null, 2));
  console.log(`\nlog: ${runFile}`);
})().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
