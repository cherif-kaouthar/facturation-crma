/**
 * Interactive release walkthrough.
 *
 *   npm run release
 *
 * Asks for the new version, bumps it in package.json and package-lock.json
 * (root + packages[""]), commits the bump, creates a vX.Y.Z tag and pushes
 * both main and the tag — which triggers the .github/workflows/release.yml CI
 * pipeline that builds the installer and publishes it as a GitHub Release.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PKG_PATH = path.join(root, 'package.json');
const LOCK_PATH = path.join(root, 'package-lock.json');

const rl = createInterface({ input: process.stdin, output: process.stdout });

const log = (msg = '') => console.log(msg);
const dim = (msg) => console.log(`\x1b[2m${msg}\x1b[0m`);
const ok = (msg) => console.log(`\x1b[32m✓ ${msg}\x1b[0m`);
const warn = (msg) => console.log(`\x1b[33m! ${msg}\x1b[0m`);

function git(args) {
  try {
    execFileSync('git', args, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    return err?.stdout?.trim() ?? '';
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function setVersion(file, version) {
  const text = fs.readFileSync(file, 'utf8');
  if (file === LOCK_PATH) {
    // Only the app's own two entries (root + packages[""]) get bumped.
    let count = 0;
    return text.replace(/"version":\s*"[^"]+"/g, (match) => {
      if (count < 2) {
        count += 1;
        return `"version": "${version}"`;
      }
      return match;
    });
  }
  // First "version" key in package.json is the app version.
  return text.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
}

function confirm(message) {
  return rl.question(`\x1b[1m${message}\x1b[0m (Y/n) `).then((a) => !/^n/i.test(a.trim()));
}

async function main() {
  log('\x1b[1m\x1b[34mRelease walkthrough\x1b[0m');
  log('═'.repeat(40));

  const current = readJson(PKG_PATH).version;
  const branch = gitOutput(['branch', '--show-current']);
  const remoteUrl = gitOutput(['remote', 'get-url', 'origin']);
  const status = gitOutput(['status', '--porcelain']);

  if (!remoteUrl) {
    console.error('No git remote "origin" configured. Aborting.');
    process.exit(1);
  }
  if (branch !== 'main') {
    warn(`You are on branch "${branch}", not "main". Releasing from the current branch anyway.`);
  }

  const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  const repoSlug = match ? `${match[1]}/${match[2]}` : null;

  log(`Current version: \x1b[1m${current}\x1b[0m`);
  log(`Repository:      ${repoSlug ?? remoteUrl}`);

  const version = (await rl.question('\nNew version  (format X.Y.Z): ')).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`\x1b[31mInvalid version "${version}". Use semver format, e.g. 1.3.0.\x1b[0m`);
    process.exit(1);
  }
  const tag = `v${version}`;

  if (gitOutput(['tag', '-l', tag])) {
    warn(`Tag "${tag}" already exists. Delete it or pick another version.`);
    process.exit(1);
  }

  if (status) {
    warn('Working tree is not clean:');
    dim(status.replace(/^/gm, '  '));
  }

  // Apply edits temporarily so we can show what changes, then confirm.
  const diffLines = (() => {
    const es = [];
    const pkgAfter = setVersion(PKG_PATH, version);
    const lockAfter = setVersion(LOCK_PATH, version);
    for (const [file, before, after] of [
      ['package.json', fs.readFileSync(PKG_PATH, 'utf8'), pkgAfter],
      ['package-lock.json', fs.readFileSync(LOCK_PATH, 'utf8'), lockAfter],
    ]) {
      const oldLines = before.split('\n');
      const newLines = after.split('\n');
      newLines.forEach((line, i) => {
        if (oldLines[i] !== line) es.push({ file, old: oldLines[i], line: newLines[i] });
      });
    }
    return es;
  })();

  log('\n\x1b[1mVersion changes:\x1b[0m');
  for (const d of diffLines) {
    console.log(`  \x1b[31m- ${d.file}:\x1b[0m`);
    console.log(`    \x1b[31m- ${d.old?.trim()}\x1b[0m`);
    console.log(`    \x1b[32m+ ${d.line?.trim()}\x1b[0m`);
  }

  if (!(await confirm('\nProceed to commit, tag and push?'))) {
    log('Aborted — no changes were made.');
    rl.close();
    process.exit(0);
  }

  fs.writeFileSync(PKG_PATH, setVersion(PKG_PATH, version));
  fs.writeFileSync(LOCK_PATH, setVersion(LOCK_PATH, version));
  ok(`Bumped version to ${version} in package.json and package-lock.json`);

  git(['add', 'package.json', 'package-lock.json']);
  if (!git(['commit', '-m', `chore: bump version to ${version}`])) {
    console.error('Commit failed — the version bump was left uncommitted.');
    process.exit(1);
  }
  ok('Committed version bump');

  if (git(['tag', tag])) {
    ok(`Created tag ${tag}`);
  } else {
    console.error(`Failed to create tag ${tag}.`);
    process.exit(1);
  }

  if (!git(['push', 'origin', branch])) {
    console.error(`Failed to push ${branch}. The tag was created locally — push it manually with:\n    git push origin ${tag}`);
    process.exit(1);
  }
  ok(`Pushed ${branch}`);

  if (!git(['push', 'origin', tag])) {
    console.error(`Failed to push tag ${tag}. Push it manually with:\n    git push origin ${tag}`);
    process.exit(1);
  }
  ok(`Pushed tag ${tag} — CI release pipeline triggered`);

  log('\n\x1b[1mDone.\x1b[0m');
  if (repoSlug) {
    log(`  Actions: https://github.com/${repoSlug}/actions`);
    log(`  Release: https://github.com/${repoSlug}/releases`);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});