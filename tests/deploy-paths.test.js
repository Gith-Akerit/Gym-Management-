// Every directory the app writes to has to be on the volume.
//
// The failure this exists for is the quiet one. `SlipStore` makes its own
// directory, so an upload to a path that is not on the volume succeeds, the
// screen says it worked, and the file is gone at the next rebuild -- with no
// error in any log and no copy in the backup, because the backup only copies
// `/data`. Infra found exactly that with the gym logo: the code read
// `LOGO_STORAGE_PATH`, compose never set it, and the default landed inside the
// container image.
//
// So this test reads the code, not a list: whatever `*_STORAGE_PATH` the
// server asks for, every deploy target -- compose, Fly and Render -- must set
// under `/data`, and the entrypoint must create. A directory added next month
// is covered the day it is added, on all three hosts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/** Every `process.env.SOMETHING_PATH` the server actually reads. */
function pathsTheCodeUses() {
  const root = new URL('../server/', import.meta.url);
  const found = new Map();
  for (const file of readdirSync(root).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(join(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), file), 'utf8');
    for (const [, key, fallback] of source.matchAll(
      /process\.env\.([A-Z_]+_PATH)\s*\|\|\s*'([^']+)'/g)) {
      found.set(key, { fallback, file });
    }
  }
  return found;
}

/** The `environment:` block of the app service, as a plain object. */
function composeEnvironment() {
  const lines = read('docker-compose.yml').split('\n');
  const start = lines.findIndex(line => line.trim() === 'environment:');
  const env = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,4}\S/.test(line)) break;                    // dedented: block over
    const match = /^\s+([A-Z_]+):\s*"?([^"#]*?)"?\s*$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** The `[env]` table of fly.toml. */
function flyEnvironment() {
  const lines = read('fly.toml').split('\n');
  const start = lines.findIndex(line => line.trim() === '[env]');
  const env = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\[/.test(line)) break;                           // the next table
    const match = /^\s+([A-Z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** The `envVars:` list of render.yaml -- the entries that carry a value. */
function renderEnvironment() {
  const env = {};
  for (const [, key, value] of read('render.yaml').matchAll(
    /-\s*key:\s*([A-Z_]+)[^\n]*\n\s*value:\s*"?([^"\n]*?)"?\s*\n/g)) {
    env[key] = value;
  }
  return env;
}

// docs/deploy.md offers three ways to run this and all three keep a volume at
// /data. A variable missed on one of them is the same silent loss on that host,
// so all three answer to the same rule.
const DEPLOY_TARGETS = [
  { file: 'docker-compose.yml', env: composeEnvironment, mount: /-\s*gym-data:\/data\b/ },
  { file: 'fly.toml', env: flyEnvironment, mount: /destination\s*=\s*"\/data"/ },
  { file: 'render.yaml', env: renderEnvironment, mount: /mountPath:\s*\/data\b/ },
];

test('every storage path the server reads is set on every deploy target, under the volume', () => {
  const used = pathsTheCodeUses();
  assert.ok(used.size >= 4, `expected the server to read several paths, found ${[...used.keys()].join(', ')}`);

  for (const target of DEPLOY_TARGETS) {
    const env = target.env();
    for (const [key, { file }] of used) {
      assert.ok(env[key], `${file} reads ${key} but ${target.file} never sets it, `
        + 'so the default lands inside the container and is lost at the next rebuild');
      assert.match(env[key], /^\/data\//,
        `${key} is ${env[key]} in ${target.file}; it has to be under /data, which is the volume`);
    }
  }
});

test('every deploy target really mounts something durable at that path', () => {
  for (const { file, mount } of DEPLOY_TARGETS) {
    assert.match(read(file), mount,
      `${file} puts the app's files under /data but mounts nothing there`);
  }
  assert.match(read('docker-compose.yml'), /^volumes:\n(?:.*\n)*?\s+gym-data:/m,
    'and compose declares gym-data as a named volume');
});

test('the entrypoint creates every one of them before the app starts', () => {
  const entrypoint = read('deploy/entrypoint.sh');
  const [mkdir] = /mkdir -p[\s\S]*?\n\n/.exec(entrypoint) ?? [];
  assert.ok(mkdir, 'deploy/entrypoint.sh must make the directories before starting');
  for (const key of pathsTheCodeUses().keys()) {
    if (key === 'DATABASE_PATH') continue;                 // a file, made by its dirname
    assert.ok(mkdir.includes(key), `${key} is missing from the mkdir in deploy/entrypoint.sh`);
  }
  // A line continuation is a backslash at the end of a line. Written as the two
  // characters \n it is not a newline to sh -- it is the letter n, and mkdir
  // quietly makes a directory called "n" instead (found while fixing this).
  assert.ok(!/\\n\s/.test(mkdir), 'a literal \\n in the mkdir line makes a directory called "n"');
});

test('the backup copies the whole volume, which is where all of them live', () => {
  // If a path ever moves outside /data, the backup stops covering it silently:
  // this is the line that makes "under /data" mean "in the backup".
  assert.match(read('deploy/backup.sh'), /docker compose cp app:\/data\/\./);
});

test('the documented defaults are the ones the code and compose actually use', () => {
  const docs = read('docs/deploy.md');
  const env = composeEnvironment();
  for (const key of pathsTheCodeUses().keys()) {
    // The row in the env checklist, whose first cell is the key itself -- not
    // the storage table further up, which names the same variables in prose.
    const row = docs.split('\n').find(line => line.startsWith(`| \`${key}\``));
    assert.ok(row, `docs/deploy.md has no row for ${key}`);
    assert.ok(row.includes(env[key]),
      `docs/deploy.md says something other than ${env[key]} for ${key}: ${row.trim()}`);
  }
});
