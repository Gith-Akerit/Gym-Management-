// QA Release Tester — BRAND-14: where the gym's own files actually land.
//
// The failure this guards is the quiet one Infra found: the app writes a logo,
// the upload succeeds, the owner sees it on the card -- and it is gone at the
// next rebuild, with no error anywhere and no copy in the backup. Nothing in
// the application can notice that, because from inside the container the write
// worked. The only place it shows up is the deployment files.
//
// The team added `tests/deploy-paths.test.js` at `0483464`. These probe whether
// that guard actually holds when somebody breaks it, rather than whether it
// passes today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = name => readFileSync(name, 'utf8');

/** Every `*_STORAGE_PATH` the server code actually reads, from the code. */
function pathsTheCodeReads() {
  const source = read('server/start.js');
  return [...new Set([...source.matchAll(/process\.env\.([A-Z_]*STORAGE_PATH)/g)].map(m => m[1]))].sort();
}

/** Runs the team's own deployment guard and says whether it was happy. */
function guard() {
  try {
    // NODE_TEST_CONTEXT is inherited, and a child that believes it is
    // reporting to a parent runner exits 0 whatever happened. Without
    // stripping it, this helper calls every broken file green.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    execFileSync(process.execPath, ['--test', 'tests/deploy-paths.test.js'],
      { encoding: 'utf8', stdio: 'pipe', env });
    return { green: true, output: '' };
  } catch (e) { return { green: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}

test('DEPLOY-01 every folder the code writes to is set, on all three deploy targets', () => {
  const wanted = pathsTheCodeReads();
  console.log('DEPLOY-01 what server/start.js reads:', JSON.stringify(wanted));
  assert.ok(wanted.includes('LOGO_STORAGE_PATH'), 'the logo folder is not read from the environment at all');

  const targets = {
    'docker-compose.yml': read('docker-compose.yml'),
    'fly.toml': read('fly.toml'),
    'render.yaml': read('render.yaml'),
  };
  const report = {};
  for (const [file, text] of Object.entries(targets)) {
    report[file] = Object.fromEntries(wanted.map(name => {
      // compose and fly put the value beside the key; render.yaml puts it on
      // the line below, under `- key:`. Both shapes, or this reports a
      // perfectly good file as broken.
      const beside = new RegExp(`${name}\\s*[:=]\\s*["']?(/[^"'\\s]+)`).exec(text);
      const below = new RegExp(`key:\\s*${name}\\s*\\n\\s*value:\\s*["']?(/[^"'\\s]+)`).exec(text);
      return [name, beside?.[1] ?? below?.[1] ?? null];
    }));
  }
  console.log('DEPLOY-01 where each target puts them:\n' + JSON.stringify(report, null, 1));
  for (const [file, found] of Object.entries(report)) {
    for (const [name, value] of Object.entries(found)) {
      assert.ok(value, `${file} never sets ${name}, so it falls inside the container and is lost on rebuild`);
      assert.ok(value.startsWith('/data/') || value === '/data',
        `${file} puts ${name} at ${value}, which is not on the volume`);
    }
  }
});

test('DEPLOY-02 the guard the team added actually fails when somebody breaks it', t => {
  const before = guard();
  console.log('DEPLOY-02 tests/deploy-paths.test.js as it stands ->', before.green ? 'green' : 'red');
  assert.equal(before.green, true, 'the deployment guard is already failing');

  // Take each one out in turn and check the guard notices. A test that only
  // ever passes is a test nobody knows the shape of.
  const files = ['docker-compose.yml', 'fly.toml', 'render.yaml'];
  const originals = Object.fromEntries(files.map(f => [f, read(f)]));
  t.after(() => { for (const [f, text] of Object.entries(originals)) writeFileSync(f, text); });

  const caught = {};
  for (const file of files) {
    for (const name of pathsTheCodeReads()) {
      writeFileSync(file, originals[file].split('\n')
        .filter(line => !line.includes(name)).join('\n'));
      const after = guard();
      caught[`${file} without ${name}`] = after.green ? 'SLIPPED THROUGH' : 'caught';
      writeFileSync(file, originals[file]);
    }
  }
  console.log('DEPLOY-02 taking each one out:\n' + JSON.stringify(caught, null, 1));
  const missed = Object.entries(caught).filter(([, v]) => v !== 'caught');
  assert.equal(missed.length, 0, `the guard does not notice: ${JSON.stringify(missed.map(([k]) => k))}`);
});

test('DEPLOY-03 the entrypoint makes every folder, and makes none it did not mean to', () => {
  const script = read('deploy/entrypoint.sh');
  const line = /mkdir -p[\s\S]*?\n\n/.exec(script)?.[0] ?? '';
  console.log('DEPLOY-03 the line that makes them:\n' + line.trim());
  // A literal backslash-n inside the command is read by `sh` as an argument
  // called `n`: the shell makes a directory named `n` and silently stops
  // making the ones that were supposed to follow it.
  assert.ok(!/\\n\s/.test(line.replace(/\\\n/g, '')),
    'the mkdir line carries a literal \\n, so sh makes a directory called n and skips the rest');

  const dir = mkdtempSync(join(tmpdir(), 'qa-entry-'));
  try {
    // Run the real line, in a sandbox, with the real defaults.
    const script2 = `set -e\ncd "${dir.replace(/\\/g, '/')}"\n${line}\nfind . -type d | sort\n`;
    const out = execFileSync('sh', ['-c', script2], { encoding: 'utf8' });
    const made = out.trim().split('\n').map(s => s.replace(/^\.\//, '').trim()).filter(Boolean);
    console.log('DEPLOY-03 what it really creates:', JSON.stringify(made));
    for (const folder of ['data', 'data/slips', 'data/photos', 'data/logo']) {
      assert.ok(made.includes(folder), `the entrypoint does not create ${folder}`);
    }
    assert.ok(!made.includes('n'), 'the entrypoint created a directory called n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DEPLOY-04 the same line before the fix is what left a directory called n', () => {
  // Kept as the record of what was actually wrong, because "we fixed the
  // entrypoint" is not the same statement as "this is what it did".
  const old = 'mkdir -p "$(dirname "${DATABASE_PATH:-./data/gym.sqlite}")" "${SLIP_STORAGE_PATH:-./data/slips}" '
    + '\\n  "${PHOTO_STORAGE_PATH:-./data/photos}"';
  const dir = mkdtempSync(join(tmpdir(), 'qa-entry-old-'));
  try {
    execFileSync('sh', ['-c', `set -e\ncd "${dir.replace(/\\/g, '/')}"\n${old}\n`], { encoding: 'utf8' });
    const made = readdirSync(dir).sort();
    console.log('DEPLOY-04 the old line created:', JSON.stringify(made));
    assert.ok(made.includes('n'), 'the old line is not reproducing the way it failed');
    // Measured rather than assumed: `sh` reads the literal backslash-n as one
    // more argument called `n`, so it makes a stray directory AND still makes
    // the folder that was meant to be on the next line. The damage was litter,
    // not a missing folder -- worth saying plainly, because "the photographs
    // folder was never created" would have been the wrong report.
    const inside = readdirSync(join(dir, 'data')).sort();
    console.log('DEPLOY-04 and inside data/:', JSON.stringify(inside),
      '· the photographs folder was still made, so the only damage was the stray "n"');
    assert.ok(inside.includes('photos'), 'the old line skipped the photographs folder as well');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DEPLOY-05 the backup takes everything that is on the volume', () => {
  const backup = read('deploy/backup.sh');
  const copies = [...backup.matchAll(/app:(\/[^\s"']+)/g)].map(m => m[1]);
  console.log('DEPLOY-05 what backup.sh copies out of the container:', JSON.stringify(copies));
  assert.ok(copies.some(path => path === '/data' || path === '/data/.' || path.startsWith('/data/.')),
    'the backup does not take the whole of /data, so a new folder under it is not in the copy');

  const docs = read('docs/deploy.md');
  for (const name of pathsTheCodeReads()) {
    assert.ok(docs.includes(name), `docs/deploy.md never mentions ${name}`);
  }
  // The document told the reader the logo lived on the volume while the compose
  // file did not put it there (Infra). What it says has to be what is set.
  for (const name of pathsTheCodeReads()) {
    // The settings-table row whose first cell IS this variable. Any other line
    // that merely mentions it can name a different folder in passing, which is
    // how this probe first accused a correct document of disagreeing.
    const inDocs = new RegExp(`^\\|\\s*\`${name}\`[^\\n]*?(/data/[a-z.]+)`, 'm').exec(docs)?.[1];
    const inCompose = new RegExp(`${name}:\\s*(/data/[a-z.]+)`).exec(read('docker-compose.yml'))?.[1];
    console.log(`DEPLOY-05 ${name}: docs say ${inDocs} · compose sets ${inCompose}`);
    if (inDocs && inCompose) assert.equal(inDocs, inCompose, `docs/deploy.md and docker-compose.yml disagree about ${name}`);
  }
});

test('DEPLOY-06 a logo written to the default path would not be on the volume', () => {
  // The whole point, stated as the thing a person would check on the box.
  const start = read('server/start.js');
  const fallback = /LOGO_STORAGE_PATH\s*\|\|\s*'([^']+)'/.exec(start)?.[1];
  console.log('DEPLOY-06 where the logo goes when nothing sets the variable:', JSON.stringify(fallback));
  assert.ok(fallback, 'there is no default at all, which would be worse');
  assert.ok(!fallback.startsWith('/data'),
    'the default is already on the volume, so this check has stopped meaning anything');
  console.log('DEPLOY-06 so the variable must be set by every deploy target — which DEPLOY-01 checks');

  // And the folder is a directory of its own, not shared with the slips: a
  // logo and a payment slip must never be able to collide by filename.
  const roots = [...start.matchAll(/([A-Z_]*STORAGE_PATH)\s*\|\|\s*'([^']+)'/g)].map(m => [m[1], m[2]]);
  console.log('DEPLOY-06 every store and its default:', JSON.stringify(roots));
  const places = roots.map(([, path]) => path);
  assert.equal(new Set(places).size, places.length, 'two stores share a folder');
  const dir = mkdtempSync(join(tmpdir(), 'qa-store-'));
  try {
    for (const [, path] of roots) mkdirSync(join(dir, path.replace('./', '')), { recursive: true });
    console.log('DEPLOY-06 they really are separate folders:', JSON.stringify(readdirSync(join(dir, 'data')).sort()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
