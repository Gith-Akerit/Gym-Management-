import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Read .env when there is one, and say nothing when there is not.
 *
 * `node --env-file-if-exists=.env` prints ".env not found. Continuing without
 * it." whenever the file is absent, which is the normal case in a container:
 * the values arrive through compose's env_file and never become a file inside
 * the image. The gym owner runs these commands in a hosting panel, and a line
 * about a missing file is the wrong thing to read first when you are looking
 * for a six digit code -- it reads like the reason something failed.
 *
 * Precedence is unchanged: a value already in the environment wins over the
 * file, exactly as the flag behaved.
 */
const path = resolve(process.env.ENV_FILE || '.env');
if (existsSync(path)) process.loadEnvFile(path);
