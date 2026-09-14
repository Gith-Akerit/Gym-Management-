#!/usr/bin/env python3
"""Hidden terminal setup; never source .env or put credentials in argv/logs."""
import getpass
import os
from pathlib import Path
import re
import secrets
import shlex
import smtplib
import ssl
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
    """The values a live gym needs and a pilot one does not have yet."""
    promptpay = ask('PromptPay ID')
    provider = ask('SMTP preset: enter gmail or brevo').lower()
    if provider not in ('gmail', 'brevo'):
        raise ValueError('Choose gmail or brevo.')
    user = ask('Gmail address' if provider == 'gmail' else 'Brevo SMTP login')
    password = ask('Gmail App Password' if provider == 'gmail' else 'Brevo SMTP key')
    sender = user if provider == 'gmail' else ask('Brevo verified sender email')
    if provider == 'gmail':
        password = password.replace(' ', '')
    if not re.fullmatch(r'(0\d{9}|66\d{9}|\d{13}|\d{15})', promptpay):
        raise ValueError('Invalid PromptPay ID format.')
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', sender):
        raise ValueError('Invalid sender email format.')
    return dict(PROMPTPAY_ID=promptpay,
                SMTP_HOST='smtp.gmail.com' if provider == 'gmail' else 'smtp-relay.brevo.com',
                SMTP_PORT='587', SMTP_SECURE='false', SMTP_USER=user,
                SMTP_PASSWORD=password, MAIL_FROM=sender)


def check_smtp(values):
    try:
        with smtplib.SMTP(values['SMTP_HOST'], int(values['SMTP_PORT']), timeout=20) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
            smtp.login(values['SMTP_USER'], values['SMTP_PASSWORD'])
    except Exception:
        raise ValueError('SMTP TLS/login failed. Check credentials and outbound port 587; .env was not changed.') from None
    print('SMTP TLS/login: OK (email delivery still needs a real OTP test).')


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
        admin = ask('Reporter email for administrator login')
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', admin):
            raise ValueError('Invalid administrator email format.')
        values = dict(NODE_ENV='production', HOST='0.0.0.0', PORT='3000',
                      APP_DOMAIN='srv1979069.hstgr.cloud',
                      APP_ORIGIN='https://srv1979069.hstgr.cloud', TRUST_PROXY='1',
                      DATABASE_PATH='/data/gym.sqlite', SLIP_STORAGE_PATH='/data/slips',
                      SLIP_RETENTION_DAYS='365', OTP_SECRET=secrets.token_hex(32),
                      ADMIN_EMAIL=admin, ALLOW_DESTRUCTIVE_ROLLBACK='')
        # A pilot has no merchant account and no mailbox. The keys are written
        # empty rather than left to the template, whose development defaults
        # would otherwise look like real configuration the app is ignoring.
        values.update(PILOT_MODE='1', PROMPTPAY_ID='', SMTP_HOST='', SMTP_PORT='',
                      SMTP_SECURE='', SMTP_USER='', SMTP_PASSWORD='', MAIL_FROM='')
        if not pilot:
            values.update(PILOT_MODE='', **ask_credentials())
    if clear_admin:
        values['ADMIN_EMAIL'] = ''
    elif pilot:
        # Rerunning with --pilot on a live environment puts it back into pilot
        # mode without touching the credentials already saved.
        values['PILOT_MODE'] = '1'
        print('Pilot mode: OTP codes appear in the admin console; no email is sent.')
    else:
        # Leaving pilot mode: ask for whatever the pilot never collected, and
        # only clear the flag once the mail server has actually accepted a
        # login. A failure here leaves .env exactly as it was.
        if not values.get('SMTP_HOST') or not values.get('PROMPTPAY_ID'):
            require_terminal()
            print('Going live: PromptPay and email are needed before payments and OTP mail work.')
            values.update(ask_credentials())
        check_smtp(values)
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
