#!/usr/bin/env node
/**
 * Put a secret into .env on the server, in one command, without printing it.
 *
 *   npm run env:set -- PROMPTPAY_ID=0812345678
 *   npm run env:set -- SMTP_USER=... SMTP_PASSWORD=...
 *   npm run env:set -- --stdin SMTP_PASSWORD     (reads the value from stdin)
 *   npm run env:set -- --list                    (key names and whether set)
 *
 * The gym owner is the one holding the PromptPay ID and the mail key, and the
 * only place they can run a command is the hosting panel's browser terminal.
 * That makes three things matter: it has to be one line, it must never echo the
 * value back onto a screen that may be shared, and a mistake must not be able
 * to truncate a .env that already has the rest of the configuration in it.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const ENV_PATH = resolve(process.env.ENV_FILE || '.env');
const KEY = /^[A-Z][A-Z0-9_]*$/;
const QUOTES = ['"', "'", '`'];

/**
 * Anything a shell would reinterpret gets quoted. Node's --env-file reader
 * treats a quote as running to the next matching one and honours no escapes at
 * all, so the quote character has to be one the value does not contain -- a
 * backslash-escaped quote would silently truncate the value at that point.
 */
function encode(value) {
  if (value === '') return '';
  if (/^[A-Za-z0-9_@%+:,./-]+$/.test(value)) return value;
  const quote = QUOTES.find(candidate => !value.includes(candidate));
  if (!quote) throw new Error('This value contains all three quote characters and cannot be written to .env. '
    + 'Put it in the file by hand, or ask the provider for a key without quotes in it.');
  return quote + value + quote;
}

const read = () => (existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '');
const toLines = text => text.replace(/\r\n/g, '\n').split('\n');

/**
 * Rewrites the line the key is already on, so comments, order and every other
 * value survive. Only a key that is genuinely new is appended.
 */
function apply(lines, key, value) {
  const line = `${key}=${encode(value)}`;
  const at = lines.findIndex(existing => existing.startsWith(`${key}=`));
  if (at === -1) {
    const body = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return { lines: [...body, line, ''], action: 'added' };
  }
  const copy = [...lines];
  const action = copy[at] === line ? 'unchanged' : 'updated';
  copy[at] = line;
  return { lines: copy, action };
}

function write(text) {
  // Written beside the target and renamed over it: a crash half way through
  // leaves the old file whole rather than a truncated one the app cannot boot
  // from. The mode is set on the temporary file too, so the secret is never
  // briefly readable by anyone else on the box.
  const temporary = resolve(dirname(ENV_PATH), `.env.${process.pid}.tmp`);
  writeFileSync(temporary, text, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows has no such mode */ }
  renameSync(temporary, ENV_PATH);
  try { chmodSync(ENV_PATH, 0o600); } catch { /* as above */ }
}

function list() {
  const parsed = parseEnv(read());
  const rows = Object.keys(parsed).map(key => `${parsed[key] ? 'set  ' : 'EMPTY'}  ${key}`);
  console.log(rows.length ? rows.join('\n') : `${ENV_PATH} has no values yet`);
  console.log('\nValues are never printed. To see one, open the file yourself.');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // A value typed into a prompt almost always arrives with a trailing newline.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log(`Usage:
  npm run env:set -- KEY=VALUE [KEY=VALUE ...]
  npm run env:set -- --stdin KEY      read the value from stdin instead
  npm run env:set -- --list           key names and whether each has a value

Writes ${ENV_PATH}. Values are never echoed. Restart the service afterwards for
them to take effect: docker compose up -d, or pm2 restart gym.

On a shared or recorded terminal, put one space before the command -- most
shells then keep it out of the history file.`);
  process.exit(args.length ? 0 : 1);
}

if (args[0] === '--list') { list(); process.exit(0); }

let pairs;
if (args[0] === '--stdin') {
  const key = args[1];
  if (!key || !KEY.test(key)) { console.error('--stdin needs one KEY, in CAPITALS_WITH_UNDERSCORES'); process.exit(1); }
  pairs = [[key, await readStdin()]];
} else {
  pairs = args.map(argument => {
    const at = argument.indexOf('=');
    if (at < 1) { console.error(`Expected KEY=VALUE, got "${argument.split('=')[0]}=..."`); process.exit(1); }
    const key = argument.slice(0, at);
    if (!KEY.test(key)) { console.error(`"${key}" is not a valid name: CAPITALS, digits and underscores only`); process.exit(1); }
    return [key, argument.slice(at + 1)];
  });
}

const original = read();
let lines = toLines(original);
const done = [];
try {
  for (const [key, value] of pairs) {
    const result = apply(lines, key, value);
    lines = result.lines;
    done.push(`${result.action.padEnd(9)} ${key}${value === '' ? '  (empty)' : ''}`);
  }
} catch (error) { console.error(error.message); process.exit(1); }

write(lines.join('\n'));

// Read it back through the same parser Node itself uses for --env-file. A value
// the app would read differently from what was asked for is worse than a
// refusal: the gym would find out when a member's OTP silently stops arriving.
const parsed = parseEnv(read());
const wrong = pairs.filter(([key, value]) => (parsed[key] ?? '') !== value);
if (wrong.length) {
  write(original);
  console.error(`Could not store ${wrong.map(([key]) => key).join(', ')} so that the app reads it back unchanged.`);
  console.error(`${ENV_PATH} has been left exactly as it was. Edit the file by hand for this value.`);
  process.exit(1);
}

console.log(done.join('\n'));
console.log(`\nWrote ${ENV_PATH} and read it back unchanged. Restart the service for it to take effect.`);
