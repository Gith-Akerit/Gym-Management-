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

if __name__ == '__main__':
    unittest.main()
