#!/usr/bin/env node
// Runs the `test:*` scripts of package.json in parallel, each in its own
// process (and so its own LuaJIT engine). `npm run test:all` calls this.
//
//   node scripts/run-tests.mjs                 every test:* script
//   node scripts/run-tests.mjs bridge phase4   only test:bridge and test:phase4
//   node scripts/run-tests.mjs --jobs 1        one at a time (also TEST_JOBS=1)
//
// A script is picked up automatically when its command is `tsx test/<file>.ts`.
// Output is buffered per script and printed when that script ends, so logs do
// not interleave. Exit code is 1 when any script fails.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_DEFAULT_JOBS = 6;
// A script still running after this is killed and reported as failed with the
// output it produced, so a hang shows which script hung.
const SCRIPT_TIMEOUT_MS = 15 * 60_000;

// Scripts that cannot share the machine with other engines. They run one at a
// time after everything else. test:startup counts every LuaJIT process on the
// machine to prove an engine swap leaves exactly one.
const EXCLUSIVE = ['startup'];

// Longest first, so the slow scripts never end up queued behind each other.
// Scripts not listed here still run, after these.
const SLOWEST_FIRST = [
  'crash-recovery', 'item-restore', 'phase4', 'integrity', 'tree-restore',
  'skills-restore', 'phase5', 'convert-tree',
];

function fail(message) {
  console.error(`run-tests: ${message}`);
  process.exit(2);
}

function discover() {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
  const tests = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('test:') || name === 'test:all') continue;
    const m = /^tsx (test\/[\w.-]+\.ts)$/.exec(command);
    if (!m) fail(`cannot run "${name}": expected "tsx test/<file>.ts", got "${command}"`);
    tests.set(name.slice('test:'.length), m[1]);
  }
  return tests;
}

function parseArgs(argv, tests) {
  let jobs = process.env.TEST_JOBS;
  const wanted = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--jobs' || arg === '-j') jobs = argv[++i] ?? '';
    else if (arg.startsWith('--jobs=')) jobs = arg.slice('--jobs='.length);
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else wanted.push(arg.replace(/^test:/, ''));
  }
  for (const name of wanted) {
    if (!tests.has(name)) fail(`no script "test:${name}" (have: ${[...tests.keys()].join(', ')})`);
  }
  let jobCount = Math.min(os.availableParallelism(), MAX_DEFAULT_JOBS);
  if (jobs !== undefined) {
    jobCount = Number(jobs);
    if (!Number.isInteger(jobCount) || jobCount < 1) fail(`--jobs / TEST_JOBS must be a positive integer, got "${jobs}"`);
  }
  const names = wanted.length > 0 ? [...new Set(wanted)] : [...tests.keys()];
  const rank = (n) => { const i = SLOWEST_FIRST.indexOf(n); return i === -1 ? SLOWEST_FIRST.length : i; };
  names.sort((a, b) => rank(a) - rank(b));
  return { names, jobCount };
}

function runOne(name, file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    const done = (code, note) => resolve({
      name, code, note, seconds: (Date.now() - started) / 1000, output: Buffer.concat(chunks).toString('utf8'),
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, SCRIPT_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); done(1, `could not start: ${e.message}`); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) done(1, `killed after ${SCRIPT_TIMEOUT_MS / 60_000} min`);
      else done(code ?? 1, signal ? `killed by ${signal}` : undefined);
    });
  });
}

function report(result) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const status = result.code === 0 ? 'ok' : `FAILED (exit ${result.code}${result.note ? `, ${result.note}` : ''})`;
  const title = `test:${result.name} — ${status} — ${result.seconds.toFixed(1)}s`;
  // A failed script's output stays outside a folded group so it is seen at once.
  const fold = inActions && result.code === 0;
  console.log(fold ? `::group::${title}` : `\n===== ${title} =====`);
  process.stdout.write(result.output.endsWith('\n') || result.output === '' ? result.output : `${result.output}\n`);
  if (fold) console.log('::endgroup::');
}

const tests = discover();
const { names, jobCount } = parseArgs(process.argv.slice(2), tests);
const startedAll = Date.now();
const queue = names.filter((n) => !EXCLUSIVE.includes(n));
const alone = names.filter((n) => EXCLUSIVE.includes(n));
const lanes = Math.min(jobCount, queue.length);
console.log(`run-tests: ${names.length} script(s), ${Math.max(lanes, 1)} at a time${alone.length > 0 && queue.length > 0 ? `, then ${alone.map((n) => `test:${n}`).join(', ')} alone` : ''}`);

const results = [];
async function worker() {
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const result = await runOne(name, tests.get(name));
    results.push(result);
    report(result);
  }
}
await Promise.all(Array.from({ length: lanes }, worker));
queue.push(...alone);
await worker();

const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.code === 0 && /^SKIPPED/m.test(r.output));
console.log(`\n===== summary: ${results.length - failed.length} passed, ${failed.length} failed, ${((Date.now() - startedAll) / 1000).toFixed(0)}s =====`);
for (const r of results.sort((a, b) => b.seconds - a.seconds)) {
  console.log(`${r.code === 0 ? 'ok    ' : 'FAILED'}  ${r.seconds.toFixed(1).padStart(6)}s  test:${r.name}`);
}
if (skipped.length > 0) console.log(`printed SKIPPED: ${skipped.map((r) => `test:${r.name}`).join(', ')}`);
if (failed.length > 0) console.log(`FAILED: ${failed.map((r) => `test:${r.name}`).join(', ')}`);
process.exitCode = failed.length > 0 ? 1 : 0;
