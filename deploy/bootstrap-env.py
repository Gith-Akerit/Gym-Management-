#!/usr/bin/env python3
"""Hidden terminal setup; never source .env or put credentials in argv/logs."""
import getpass
import os
from pathlib import Path
import re
import secrets
import shlex
import sys
import tempfile
import warnings

warnings.simplefilter('error', getpass.GetPassWarning)

MARKER = '# gym-bootstrap managed environment v1'

def read_env(path):
    text = path.read_text(encoding='utf-8')
    if not text.startswith(MARKER + '\n'):
        raise ValueError('Existing .env is not bootstrap-managed; review it manually.')
    result = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        key, value = line.split('=', 1)
        parsed = shlex.split(value, comments=False)
        result[key] = parsed[0] if parsed else ''
    return result

def write_env(path, values, template):
    # Single quotes prevent Compose interpolation of dollars and hash characters.
    for value in values.values():
        if any(c in value for c in "'\r\n\x00"):
            raise ValueError('A value contains unsupported quote/control characters.')
    lines = [MARKER]
    written = set()
    for line in template.splitlines():
        key = line.split('=', 1)[0]
        if key in values:
            if key not in written:
                lines.append(f"{key}='{values[key]}'")
                written.add(key)
        else:
            lines.append(line)
    lines.extend(f"{key}='{value}'" for key, value in values.items() if key not in written)
    fd, name = tempfile.mkstemp(prefix='.env-bootstrap-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as output:
            output.write('\n'.join(lines) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def ask_credentials():
    """The one value a live gym needs and a pilot one does not have yet.

    Email is no longer among them. Staff sign in with a password and members do
    not sign in at all, so no path a gym depends on goes through a mail provider
    any more -- which is the whole reason the login changed.
    """
    promptpay = ask('PromptPay ID')
    if not re.fullmatch(r'(0\d{9}|66\d{9}|\d{13}|\d{15})', promptpay):
        raise ValueError('Invalid PromptPay ID format.')
    return dict(PROMPTPAY_ID=promptpay)


def ask_admin_password():
    """The password the owner signs in with on day one, asked for twice."""
    password = ask('Password for the administrator account (at least 12 characters)')
    if len(password.strip()) < 12:
        raise ValueError('The administrator password must be at least 12 characters.')
    if password != ask('Type the administrator password again'):
        raise ValueError('The two passwords do not match; nothing was saved.')
    return password


def require_terminal():
    """Stop before asking, rather than let getpass read the curl pipe instead.

    The mode is not incidental: 'r+' builds a BufferedRandom, which refuses to
    wrap anything it cannot seek, and no terminal is seekable. Written that way
    the check rejected every real terminal instead of the missing one it was
    for, so the installer could not finish anywhere -- hPanel's console
    included -- and said only 'File or stream is not seekable.' on the way out.
    """
    with open('/dev/tty', 'r'):
        pass

def ask(label):
    value = getpass.getpass(label + ' (hidden): ').strip()
    if not value:
        raise ValueError('A required value was empty; rerun setup.')
    return value

def configure(root, clear_admin=False, pilot=False):
    path = root / '.env'
    template = (root / '.env.example').read_text(encoding='utf-8')
    if path.exists():
        values = read_env(path)
    else:
        if clear_admin:
            raise ValueError('Environment does not exist.')
        # getpass must never fall back to reading curl input or echoing passwords.
        require_terminal()
        admin = ask('Email for the administrator login')
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', admin):
            raise ValueError('Invalid administrator email format.')
        # Asked for here and consumed by the first boot: from then on the owner
        # changes it on the "ผู้ใช้และสิทธิ์" screen, never in a file.
        admin_password = ask_admin_password()
        values = dict(NODE_ENV='production', HOST='0.0.0.0', PORT='3000',
                      APP_DOMAIN='srv1979069.hstgr.cloud',
                      APP_ORIGIN='https://srv1979069.hstgr.cloud', TRUST_PROXY='1',
                      DATABASE_PATH='/data/gym.sqlite', SLIP_STORAGE_PATH='/data/slips',
                      PHOTO_STORAGE_PATH='/data/photos',
                      SLIP_RETENTION_DAYS='365', CARD_SIGNING_SECRET=secrets.token_hex(32),
                      ADMIN_EMAIL=admin, ADMIN_PASSWORD=admin_password,
                      ALLOW_DESTRUCTIVE_ROLLBACK='')
        # A pilot has no merchant account yet. The key is written empty rather
        # than left to the template, whose development default would otherwise
        # look like real configuration the app is ignoring.
        values.update(PILOT_MODE='1', PROMPTPAY_ID='')
        if not pilot:
            values.update(PILOT_MODE='', **ask_credentials())
    if clear_admin:
        # Both are consumed by the first boot and must not sit in a file on
        # disk afterwards.
        values['ADMIN_EMAIL'] = ''
        values['ADMIN_PASSWORD'] = ''
    elif pilot:
        # Rerunning with --pilot on a live environment puts it back into pilot
        # mode without touching the credentials already saved.
        values['PILOT_MODE'] = '1'
        print('Pilot mode: no PromptPay account. Packages are sold across the counter.')
    else:
        # Leaving pilot mode: ask for what the pilot never collected. A failure
        # here leaves .env exactly as it was.
        if not values.get('PROMPTPAY_ID'):
            require_terminal()
            print('Going live: a PromptPay account is needed before the old slip queue can be used.')
            values.update(ask_credentials())
        values['PILOT_MODE'] = ''
    write_env(path, values, template)
    print('Environment saved securely; values are not displayed.')

if __name__ == '__main__':
    try:
        flags = sys.argv[1:]
        if flags and flags not in (['--clear-admin'], ['--pilot']):
            raise ValueError('Usage: bootstrap-env.py [--pilot | --clear-admin]')
        configure(Path('/srv/gym'), flags == ['--clear-admin'], flags == ['--pilot'])
    except Exception as error:
        # Only our fixed validation messages are safe to display.
        print(str(error) if isinstance(error, ValueError) else 'Environment setup failed; check file permissions and terminal.', file=sys.stderr)
        sys.exit(1)
