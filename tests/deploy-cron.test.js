// Every prune the app ships has to be scheduled on a machine that installs it.
//
// The failure this exists for is one nobody can see. `npm run reports:prune`
// was written, documented, and given a retention of 180 days -- and no cron
// line anywhere called it. Nothing errors, no log says anything: the files
// simply stay forever, which for report screenshots means a member's name and
// photo sitting on disk long after the policy said they were gone. Infra added
// the line by hand on the live server, so the live server was fine and every
// machine installed from this repo afterwards would not have been.
//
// So this reads package.json rather than a list: a `*:prune` script added next
// month is covered the day it is added, without anybody remembering that a
// prune needs a cron line to be worth anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/** Every `something:prune` script in package.json. */
function pruneScripts() {
  return Object.keys(JSON.parse(read('package.json')).scripts).filter(name => name.endsWith(':prune'));
}

/**
 * The body of the /etc/cron.d/gym-pilot heredoc that bootstrap.sh writes --
 * the crontab as it will exist on the installed machine, not the script around
 * it. A line in a comment or an echo elsewhere in the file must not count as a
 * scheduled job.
 */
function crontab() {
  const body = /cat > \/etc\/cron\.d\/gym-pilot <<'CRON'\n([\s\S]*?)\nCRON\n/.exec(read('deploy/bootstrap.sh'));
  assert.ok(body, 'deploy/bootstrap.sh no longer writes /etc/cron.d/gym-pilot the way this test reads it');
  return body[1].split('\n').filter(line => line.trim() && !line.startsWith('#'));
}

/** A cron.d line: five schedule fields, then the user, then the command. */
const JOB = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.+)$/;

test('every prune script the app ships has a cron line in the installer', () => {
  const scripts = pruneScripts();
  assert.ok(scripts.length >= 2,
    `expected several prune scripts, found ${scripts.join(', ') || 'none'} — the regex may no longer match`);

  const jobs = crontab().filter(line => JOB.test(line) && !/^[A-Z_]+=/.test(line));
  for (const script of scripts) {
    const job = jobs.find(line => line.includes(`npm run ${script}`));
    assert.ok(job, `package.json has "${script}" but /etc/cron.d/gym-pilot never runs it, `
      + 'so a freshly installed machine keeps those files forever while the docs promise a retention');

    // Without the lock, a prune can start while the backup is halfway through
    // copying /data and land a half-deleted directory in the archive.
    assert.match(job, /flock -n \/run\/gym-maintenance\.lock/,
      `the cron line for ${script} does not take /run/gym-maintenance.lock, so it can run during the backup`);

    // A job whose output goes nowhere fails silently for months.
    assert.match(job, />>\s*\/var\/log\/\S+\s+2>&1/,
      `the cron line for ${script} discards its output, so a failure leaves no trace`);
  }
});

test('the schedule fields are ones cron will actually accept', () => {
  for (const line of crontab()) {
    if (/^[A-Z_]+=/.test(line)) continue;                  // SHELL= / PATH=
    const parsed = JOB.exec(line);
    assert.ok(parsed, `not a cron.d line: ${line}`);
    const [, schedule, user] = parsed;
    // cron.d takes a user column that plain crontabs do not. Leaving it out
    // makes cron read the first word of the command as the user and drop the
    // job with one line in syslog that nobody reads.
    assert.equal(user, 'root', `the user column of this line is "${user}", not root: ${line}`);
    for (const field of schedule.split(/\s+/)) {
      assert.match(field, /^[\d*,\-/]+$/, `"${field}" is not a schedule field: ${line}`);
    }
  }
});

test('docs/deploy.md schedules the same set, for anyone not using the installer', () => {
  // bootstrap.sh only covers the Hostinger install. The other ways to run this
  // are in deploy.md, and a prune missing there is the same files kept forever.
  const docs = read('docs/deploy.md');
  for (const script of pruneScripts()) {
    assert.ok(docs.includes(`npm run ${script}`),
      `docs/deploy.md never mentions ${script}, so a hand-installed machine will not schedule it`);
  }
});
