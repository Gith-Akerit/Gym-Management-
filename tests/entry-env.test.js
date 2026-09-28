// A command that reads its configuration has to read .env first.
//
// The failure this exists for reports success. `npm run content:import` was
// the one script in package.json without `load-env.js`, so `DATABASE_PATH`
// from .env was invisible to it: it fell back to ./data/gym.sqlite, CREATED
// that file, wrote the whole member portal's content into it, and printed
// "machines: เพิ่ม 6". The database the app actually opens still had none.
// Nothing errored, nothing logged, and the first sign was a member scanning a
// sticker on a machine and getting an empty page (QA BUG-09).
//
// So this reads package.json and the source rather than a list: whatever the
// scripts run, if what it runs reads configuration out of the environment, the
// entry point has to load .env before it uses any of it. A command added next
// month is covered the day it is added.
//
// Companion to tests/deploy-paths.test.js and tests/dockerfile-copies.test.js,
// which ask the same kind of question about directories and COPY lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(ROOT, path), 'utf8');

/** Every file in server/ that a package.json script runs with node. */
function entryPoints() {
  const { scripts } = JSON.parse(read('package.json'));
  const found = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    for (const [, file] of command.matchAll(/\bnode\s+(server\/[\w./-]+)/g)) {
      assert.ok(existsSync(resolve(ROOT, file)), `npm run ${name} runs ${file}, which does not exist`);
      found.set(file, name);
    }
  }
  return found;
}

/** The entry and everything inside the repository it pulls in, transitively. */
function moduleGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(resolve(ROOT, file))) continue;
    seen.add(file);
    const source = read(file);
    for (const [, specifier] of source.matchAll(
      /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.\.?\/[^'"]+)['"]/gm)) {
      queue.push(relative(ROOT, resolve(dirname(resolve(ROOT, file)), specifier)).split('\\').join('/'));
    }
  }
  return seen;
}

/**
 * The environment variables a graph reads for configuration.
 *
 * `ENV_FILE` is not one of them: it says WHERE the file is, so a script that
 * reads only that one is the script that manages .env rather than a script
 * configured by it. That is `env:set`, and it is exempt by what it does rather
 * than by being named here.
 */
function configReads(graph) {
  const keys = new Set();
  for (const file of graph) {
    for (const [, key] of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (key !== 'ENV_FILE') keys.add(key);
    }
  }
  return keys;
}

test('every command that reads configuration loads .env before using it', () => {
  const entries = entryPoints();
  assert.ok(entries.size >= 6, `expected several server commands, found ${[...entries.keys()].join(', ')}`);

  let checked = 0;
  for (const [file, script] of entries) {
    const keys = configReads(moduleGraph(file));
    if (!keys.size) continue;                              // reads nothing: nothing to load
    checked += 1;
    const source = read(file);
    const loads = source.indexOf('load-env.js');
    assert.notEqual(loads, -1,
      `npm run ${script} runs ${file}, which reads ${[...keys].sort().slice(0, 3).join(', ')} `
      + 'from the environment but never loads .env — on a machine configured through .env it will '
      + 'silently use the defaults and report success');

    // Order is the whole point: loading .env after the value has been read is
    // the same as not loading it. Either at the top of the file, or -- for a
    // file that is also imported as a library -- before the first read inside
    // the command branch.
    const firstRead = source.search(/process\.env\.[A-Z]/);
    assert.ok(firstRead === -1 || loads < firstRead,
      `${file} loads .env after it has already read process.env, which changes nothing`);
  }
  assert.ok(checked >= 5, `only ${checked} commands were actually checked — the env scan may have stopped matching`);
});

test('importing one of those commands does not read .env as a side effect', () => {
  // server/content-import.js is a command AND a library: tests/ui-server.js
  // imports importContent from it to fill the browser suite's database. If it
  // loaded .env merely by being imported, a developer who followed the setup
  // in docs/deploy.md and has a .env would hand the browser suite their own
  // PILOT_MODE and watch tests fail that pass for everybody else.
  const source = read('server/content-import.js');
  const commandBranch = source.indexOf('import.meta.url ===');
  assert.notEqual(commandBranch, -1, 'the command branch in content-import.js has been rewritten');
  assert.ok(source.indexOf('load-env.js') > commandBranch,
    'content-import.js loads .env at import time; it is imported by tests/ui-server.js, '
    + 'so that would pull a developer\'s environment into the browser suite');
});
