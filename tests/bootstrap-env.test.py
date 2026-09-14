"""Offline security/recovery checks; no real SMTP requests or credentials."""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('bootstrap_env', Path(__file__).resolve().parents[1] / 'deploy/bootstrap-env.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BootstrapEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / '.env.example').write_text('OTP_SECRET=\nSMTP_PASSWORD=\n# template comment\n', encoding='utf-8')
        self.path = self.root / '.env'

    def create(self, provider='gmail'):
        answers = ['owner@example.test', '0812345678', provider, 'sender@example.test', 'test-only-$#-secret']
        if provider == 'brevo':
            answers.append('verified@example.test')
        with patch.object(module, 'ask', side_effect=answers), patch('builtins.open', return_value=MagicMock()), patch.object(module.smtplib, 'SMTP') as smtp:
            module.configure(self.root)
        return smtp

    def test_presets_tls_and_no_secret_output(self):
        for provider, host in [('gmail', 'smtp.gmail.com'), ('brevo', 'smtp-relay.brevo.com')]:
            with self.subTest(provider=provider):
                if self.path.exists(): self.path.unlink()
                out = io.StringIO()
                with contextlib.redirect_stdout(out): smtp = self.create(provider)
                values = module.read_env(self.path)
                self.assertEqual(values['SMTP_HOST'], host)
                self.assertEqual(values['SMTP_PASSWORD'], 'test-only-$#-secret')
                self.assertNotIn(values['SMTP_PASSWORD'], out.getvalue())
                self.assertEqual(len(values['OTP_SECRET']), 64)
                connection = smtp.return_value.__enter__.return_value
                connection.starttls.assert_called_once()
                connection.login.assert_called_once()
                self.assertIn('# template comment', self.path.read_text())

    def test_rerun_preserves_secret_and_admin_clear(self):
        self.create()
        before = self.path.read_bytes()
        with patch.object(module, 'ask', side_effect=AssertionError('must not prompt')), patch.object(module.smtplib, 'SMTP'):
            module.configure(self.root)
        self.assertEqual(self.path.read_bytes(), before)
        secret = module.read_env(self.path)['OTP_SECRET']
        module.configure(self.root, clear_admin=True)
        self.assertEqual(module.read_env(self.path)['ADMIN_EMAIL'], '')
        self.assertEqual(module.read_env(self.path)['OTP_SECRET'], secret)

    def test_failed_smtp_does_not_change_file_or_expose_server_error(self):
        self.create()
        before = self.path.read_bytes()
        with patch.object(module.smtplib, 'SMTP', side_effect=RuntimeError('SECRET_FROM_SERVER')):
            with self.assertRaisesRegex(ValueError, 'SMTP TLS/login failed') as raised:
                module.configure(self.root)
        self.assertNotIn('SECRET_FROM_SERVER', str(raised.exception))
        self.assertEqual(self.path.read_bytes(), before)

    def test_failed_first_login_leaves_no_env(self):
        with patch.object(module, 'ask', side_effect=['owner@example.test', '0812345678', 'gmail', 'sender@example.test', 'fixture']), patch('builtins.open', return_value=MagicMock()), patch.object(module.smtplib, 'SMTP', side_effect=RuntimeError()):
            with self.assertRaises(ValueError): module.configure(self.root)
        self.assertFalse(self.path.exists())

    def test_unsafe_serialization_and_unowned_env_are_not_overwritten(self):
        self.path.write_text('EXISTING=keep\n')
        with self.assertRaises(ValueError): module.configure(self.root)
        for unsafe in ["quote'break", 'new\nline', 'carriage\rreturn', 'nul\x00']:
            with self.assertRaises(ValueError): module.write_env(self.path, {'KEY': unsafe}, '')
            self.assertEqual(self.path.read_text(), 'EXISTING=keep\n')
        self.assertEqual(list(self.root.glob('.env-bootstrap-*')), [])

class PilotModeTests(unittest.TestCase):
    """--pilot exists so a gym can start with no merchant account and no mailbox."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / '.env.example').write_text(
            'NODE_ENV=development\nPILOT_MODE=\nPROMPTPAY_ID=\nSMTP_HOST=127.0.0.1\n'
            'SMTP_PORT=1025\nMAIL_FROM=gym@example.test\nOTP_SECRET=\n', encoding='utf-8')
        self.path = self.root / '.env'

    def install_pilot(self):
        with patch.object(module, 'ask', side_effect=['owner@example.test']), \
                patch('builtins.open', return_value=MagicMock()), \
                patch.object(module.smtplib, 'SMTP', side_effect=AssertionError('must not contact SMTP')):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root, pilot=True)
        return module.read_env(self.path)

    def test_pilot_asks_only_for_the_admin_and_contacts_nothing(self):
        values = self.install_pilot()
        self.assertEqual(values['PILOT_MODE'], '1')
        self.assertEqual(values['ADMIN_EMAIL'], 'owner@example.test')
        self.assertEqual(len(values['OTP_SECRET']), 64)
        self.assertEqual(values['APP_ORIGIN'], 'https://srv1979069.hstgr.cloud')
        self.assertEqual(values['NODE_ENV'], 'production')
        # The template's development defaults must not survive as something that
        # looks like configuration the app is quietly ignoring.
        for key in ('PROMPTPAY_ID', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'):
            self.assertEqual(values[key], '', key)

    def test_clearing_the_admin_keeps_pilot_mode_on(self):
        self.install_pilot()
        # This is the second call bootstrap.sh makes after the first healthy
        # boot; dropping the flag there would take the gym live by accident.
        with patch.object(module.smtplib, 'SMTP', side_effect=AssertionError('must not contact SMTP')):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root, clear_admin=True)
        values = module.read_env(self.path)
        self.assertEqual(values['PILOT_MODE'], '1')
        self.assertEqual(values['ADMIN_EMAIL'], '')

    def test_rerunning_without_pilot_collects_what_is_missing_and_goes_live(self):
        secret = self.install_pilot()['OTP_SECRET']
        answers = ['0812345678', 'brevo', 'login@smtp-brevo.com', 'smtp-key', 'verified@example.test']
        with patch.object(module, 'ask', side_effect=answers), \
                patch('builtins.open', return_value=MagicMock()), \
                patch.object(module.smtplib, 'SMTP') as smtp:
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root)
        values = module.read_env(self.path)
        self.assertEqual(values['PILOT_MODE'], '')
        self.assertEqual(values['PROMPTPAY_ID'], '0812345678')
        self.assertEqual(values['SMTP_HOST'], 'smtp-relay.brevo.com')
        self.assertEqual(values['MAIL_FROM'], 'verified@example.test')
        # Nobody is signed out by going live.
        self.assertEqual(values['OTP_SECRET'], secret)
        smtp.return_value.__enter__.return_value.login.assert_called_once()

    def test_a_failed_mail_login_leaves_the_gym_in_pilot_mode(self):
        self.install_pilot()
        before = self.path.read_bytes()
        answers = ['0812345678', 'gmail', 'gym@gmail.com', 'app password', 'gym@gmail.com']
        with patch.object(module, 'ask', side_effect=answers), \
                patch('builtins.open', return_value=MagicMock()), \
                patch.object(module.smtplib, 'SMTP', side_effect=RuntimeError('SECRET_FROM_SERVER')):
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'SMTP TLS/login failed') as raised:
                    module.configure(self.root)
        self.assertNotIn('SECRET_FROM_SERVER', str(raised.exception))
        # Still piloting, and still the same file: a half-live gym that cannot
        # send a code is worse than one that never claimed to.
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(module.read_env(self.path)['PILOT_MODE'], '1')

    def test_pilot_can_be_switched_back_on_without_touching_credentials(self):
        with patch.object(module, 'ask', side_effect=[
                'owner@example.test', '0812345678', 'gmail', 'gym@gmail.com', 'app password']), \
                patch('builtins.open', return_value=MagicMock()), \
                patch.object(module.smtplib, 'SMTP'):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root)
        live = module.read_env(self.path)
        self.assertEqual(live['PILOT_MODE'], '')

        with patch.object(module, 'ask', side_effect=AssertionError('must not prompt')), \
                patch.object(module.smtplib, 'SMTP', side_effect=AssertionError('must not contact SMTP')):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root, pilot=True)
        back = module.read_env(self.path)
        self.assertEqual(back['PILOT_MODE'], '1')
        self.assertEqual(back['SMTP_PASSWORD'], live['SMTP_PASSWORD'])
        self.assertEqual(back['PROMPTPAY_ID'], live['PROMPTPAY_ID'])


if __name__ == '__main__':
    unittest.main()
