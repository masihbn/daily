// Zero-dependency test tier runner.
//
// Usage: node tests/helpers/run-tier.mjs <tier>
//   <tier> is "unit" or "integration".
//
// Recursively collects every *.test.mjs file under tests/<tier>/, runs them
// with node:test's run() API, streams human-readable output (spec reporter)
// to stdout, and prints exactly one summary line at the end. A tier that
// finds/runs zero tests is treated as a failure, not a silent pass — the
// whole point of this runner is to make sure a broken/empty tier can never
// look green.

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const tier = process.argv[2];
if (!tier) {
  console.error('usage: node tests/helpers/run-tier.mjs <unit|integration>');
  process.exit(1);
}
if (tier.includes('/') || tier.includes('\\') || tier.includes('..')) {
  console.error('usage: node tests/helpers/run-tier.mjs <unit|integration>');
  process.exit(1);
}

const tierDir = path.join(repoRoot, 'tests', tier);

function collectTestFiles(dir) {
  let results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      results = results.concat(collectTestFiles(fullPath));
    } else if (stats.isFile() && entry.endsWith('.test.mjs')) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = collectTestFiles(tierDir);

if (files.length === 0) {
  console.error(`no test files found in tests/${tier}`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
let sawError = false;

const testStream = run({ files });

function isSuiteEvent(data) {
  // Node's test runner fires test:pass/test:fail for describe() suites as
  // well as individual tests. Only count leaf tests. Be defensive: if
  // details/details.type is missing, treat it as a test (count it) rather
  // than silently dropping it.
  return Boolean(data && data.details && data.details.type === 'suite');
}

testStream.on('test:pass', (data) => {
  if (!isSuiteEvent(data)) pass++;
});
testStream.on('test:fail', (data) => {
  if (!isSuiteEvent(data)) fail++;
});
testStream.on('error', (err) => {
  sawError = true;
  console.error(err);
});

testStream.compose(spec).pipe(process.stdout);

testStream.on('end', () => {
  console.log(`${tier} tier: ${pass} passed, ${fail} failed`);
  const total = pass + fail;
  if (sawError || fail > 0 || total === 0) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
});
