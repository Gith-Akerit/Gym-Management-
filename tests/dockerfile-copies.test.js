// What the image contains has to be what the code reaches for.
//
// `npm run build` on a laptop runs inside a checkout where every folder is
// already there, so it cannot tell you that the Dockerfile never copied one.
// `shared/brand.cjs` -- the one file the browser and the server share, added
// so there would be exactly one colour formula -- was reached by `web/` and by
// `server/` and copied into neither stage. Everything was green: 172 node
// tests, 42 browser tests, two QA suites, a GO. The build died on the box, and
// the one-line fix would have died a second time at startup, because the
// runtime stage was missing it too.
//
// So this reads the code and the Dockerfile rather than a list: whatever
// top-level folder `web/` reaches has to be COPYed into the stage that builds
// the browser bundle, and whatever `server/` reaches has to be COPYed into the
// stage that runs. A folder added next month is covered the day it is added.
//
// Companion to tests/deploy-paths.test.js, which does the same for the
// directories the app writes to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CODE = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/;

/** Every source file under a folder, all the way down. */
function* sourceFiles(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (CODE.test(entry.name)) yield path;
  }
}

/**
 * The top-level folders a tree reaches outside itself.
 *
 * Only relative paths matter here: a bare specifier is a package and arrives
 * with `npm ci`, and a builtin arrives with node. Anything written as `../`
 * is a file in this repository that somebody has to remember to copy.
 */
function foldersReachedBy(top) {
  const reached = new Map();
  for (const file of sourceFiles(join(ROOT, top))) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(
      /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|new URL\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      const target = relative(ROOT, resolve(dirname(file), specifier));
      const [folder] = target.split(sep);
      // `..` would mean a path that leaves the repository altogether.
      assert.notEqual(folder, '..', `${relative(ROOT, file)} reaches outside the repository: ${specifier}`);
      if (folder !== top) reached.set(folder, relative(ROOT, file).split(sep).join('/'));
    }
  }
  return reached;
}

/**
 * The Dockerfile, as one entry per stage.
 *
 * `COPY --from=<stage>` is an artefact handed over from an earlier stage, not
 * a folder out of the checkout, so it is not what this is asking about.
 */
function stages() {
  const lines = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
    .replace(/\\\r?\n\s*/g, ' ')                          // line continuations
    .split('\n');
  const found = new Map();
  let current = null;
  for (const line of lines) {
    const from = /^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      current = { name: from[1] ?? `stage${found.size}`, copies: new Set() };
      found.set(current.name, current);
      continue;
    }
    const copy = /^\s*COPY\s+(.*)$/i.exec(line);
    if (!copy || !current || /--from=/i.test(copy[1])) continue;
    // Everything but the last word is a source; the last one is the
    // destination inside the image.
    const words = copy[1].trim().split(/\s+/).filter(word => !word.startsWith('--'));
    for (const source of words.slice(0, -1)) current.copies.add(source.replace(/^\.\//, ''));
  }
  return found;
}

/** Does this stage copy that folder, whole or by a path inside it? */
const copies = (stage, folder) => [...stage.copies]
  .some(source => source === folder || source.startsWith(`${folder}/`));

// `web/` is compiled by the build stage; `server/` is run by the runtime one.
// Named here rather than guessed, because getting this pairing wrong is the
// failure the file exists for: the first patch put `shared/` in the stage that
// builds and left the stage that runs without it.
const TREES = [
  { top: 'web', stage: 'build', why: 'vite compiles it' },
  { top: 'server', stage: 'runtime', why: 'node runs it' },
];

test('the Dockerfile copies every folder the code reaches into the stage that needs it', () => {
  const all = stages();
  for (const { top, stage, why } of TREES) {
    const image = all.get(stage);
    assert.ok(image, `Dockerfile has no stage called ${stage}`);
    const reached = foldersReachedBy(top);
    assert.ok(copies(image, top), `the ${stage} stage never copies ${top}/, which ${why}`);

    for (const [folder, file] of reached) {
      assert.ok(existsSync(join(ROOT, folder)), `${file} imports from ${folder}/, which is not in the repository`);
      assert.ok(copies(image, folder),
        `${file} imports from ${folder}/ but the ${stage} stage never copies it, `
        + `so the image is missing a file the code asks for at ${stage === 'build' ? 'build' : 'start'}`);
    }
  }
});

test('shared/ in particular reaches both stages, because both halves use it', () => {
  // The whole reason shared/ exists is that the browser and the server must
  // work the gym's colour out with the same file. Two copies of the formula
  // would be two answers to "what colour is our green" -- and an image with
  // the file in one stage and not the other is the same bug with extra steps.
  const all = stages();
  assert.ok(statSync(join(ROOT, 'shared')).isDirectory());
  for (const stage of ['build', 'runtime']) {
    assert.ok(copies(all.get(stage), 'shared'),
      `the ${stage} stage does not copy shared/`);
  }
});

test('nothing the entrypoint or the start command needs is left out', () => {
  const all = stages();
  const runtime = all.get('runtime');
  // The two paths the Dockerfile itself names: if either is edited to point
  // somewhere that is never copied, the container exits before the first log
  // line and the only clue is a shell error.
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  for (const [, path] of dockerfile.matchAll(/(?:ENTRYPOINT|CMD)\s+\[([^\]]*)\]/g))
    for (const [, file] of path.matchAll(/"(\.?\/?[\w./-]+\.(?:sh|js))"/g)) {
      const cleaned = file.replace(/^\.\//, '');
      assert.ok(existsSync(join(ROOT, cleaned)), `Dockerfile runs ${file}, which is not in the repository`);
      assert.ok(copies(runtime, cleaned.split('/')[0]) || copies(runtime, cleaned),
        `Dockerfile runs ${file} but the runtime stage never copies it`);
    }
});

// The build argument that says which version this is.
//
// `APP_REVISION` travels with every problem report, and half of any report
// arrives after the next deploy -- without it nobody can tell which screen the
// person was describing. It is passed in at build time, which means four
// separate pieces have to agree: the Dockerfile declares it, compose forwards
// it, the deploy script reads it from git, and vite bakes it into the bundle.
// Any one of them dropping out leaves the field empty and says nothing.
test('the revision is wired from git all the way into the browser bundle', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const build = dockerfile.slice(0, dockerfile.indexOf('AS runtime'));
  assert.match(build, /^\s*ARG APP_REVISION/m, 'the build stage does not declare ARG APP_REVISION');
  assert.match(build, /^\s*ENV APP_REVISION/m,
    'ARG alone is not visible to vite: it needs ENV in the same stage');

  assert.match(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'), /APP_REVISION:\s*\$\{APP_REVISION/,
    'compose does not forward APP_REVISION into the build');

  const script = readFileSync(join(ROOT, 'deploy/up.sh'), 'utf8');
  assert.match(script, /git rev-parse --short HEAD/, 'deploy/up.sh does not read the revision from git');
  assert.match(script, /export APP_REVISION/, 'deploy/up.sh reads it but never exports it to compose');

  assert.match(readFileSync(join(ROOT, 'vite.config.js'), 'utf8'), /__APP_REVISION__/,
    'vite does not bake it into the bundle');
  assert.match(readFileSync(join(ROOT, 'web/report.jsx'), 'utf8'), /__APP_REVISION__/,
    'nothing sends it with a report, so baking it in achieves nothing');
});
