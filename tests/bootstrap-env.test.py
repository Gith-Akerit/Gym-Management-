"""Offline security/recovery checks for the installer; no network, no real secrets.

Run with: python3 tests/bootstrap-env.test.py

The mail provider is gone from this file because it is gone from the product:
staff sign in with a password and members do not sign in at all, so nothing an
installation depends on goes through SMTP. What is left to protect is the
administrator password -- which is asked for once, written once, consumed on the
first boot, and must never appear on a screen or survive in a file afterwards.
"""
import builtins
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('bootstrap_env', Path(__file__).resolve().parents[1] / 'deploy/bootstrap-env.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ADMIN_PASSWORD = 'test-only-$#-counter-password'


class BootstrapEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / '.env.example').write_text('OTP_SECRET=\nADMIN_PASSWORD=\n# template comment\n', encoding='utf-8')
        self.path = self.root / '.env'

    def create(self):
        """A live install: administrator, password twice, then PromptPay."""
        answers = ['owner@example.test', ADMIN_PASSWORD, ADMIN_PASSWORD, '0812345678']
        with patch.object(module, 'ask', side_effect=answers), patch('builtins.open', return_value=MagicMock()):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                module.configure(self.root)
        return out

    def test_the_password_is_saved_and_never_printed(self):
        out = self.create()
        values = module.read_env(self.path)
        self.assertEqual(values['ADMIN_PASSWORD'], ADMIN_PASSWORD)
        self.assertEqual(values['ADMIN_EMAIL'], 'owner@example.test')
        self.assertEqual(values['PROMPTPAY_ID'], '0812345678')
        self.assertNotIn(ADMIN_PASSWORD, out.getvalue())
        self.assertEqual(len(values['OTP_SECRET']), 64)
        self.assertEqual(values['PHOTO_STORAGE_PATH'], '/data/photos')
        self.assertIn('# template comment', self.path.read_text())

    def test_two_different_passwords_save_nothing(self):
        answers = ['owner@example.test', ADMIN_PASSWORD, 'something-else-entirely']
        with patch.object(module, 'ask', side_effect=answers), patch('builtins.open', return_value=MagicMock()):
            with self.assertRaisesRegex(ValueError, 'do not match'):
                module.configure(self.root)
        self.assertFalse(self.path.exists())

    def test_a_short_password_is_refused_before_anything_is_written(self):
        answers = ['owner@example.test', 'sun2026']
        with patch.object(module, 'ask', side_effect=answers), patch('builtins.open', return_value=MagicMock()):
            with self.assertRaisesRegex(ValueError, 'at least 12 characters'):
                module.configure(self.root)
        self.assertFalse(self.path.exists())

    def test_rerun_preserves_secret_and_clears_both_admin_values(self):
        self.create()
        before = self.path.read_bytes()
        with patch.object(module, 'ask', side_effect=AssertionError('must not prompt')):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root)
        self.assertEqual(self.path.read_bytes(), before)
        secret = module.read_env(self.path)['OTP_SECRET']

        with contextlib.redirect_stdout(io.StringIO()):
            module.configure(self.root, clear_admin=True)
        values = module.read_env(self.path)
        # Both are consumed by the first boot. A password left in a file on the
        # server is a password somebody finds in a backup two years later.
        self.assertEqual(values['ADMIN_EMAIL'], '')
        self.assertEqual(values['ADMIN_PASSWORD'], '')
        self.assertEqual(values['OTP_SECRET'], secret)

    def test_unsafe_serialization_and_unowned_env_are_not_overwritten(self):
        self.path.write_text('EXISTING=keep\n')
        with self.assertRaises(ValueError):
            module.configure(self.root)
        for unsafe in ["quote'break", 'new\nline', 'carriage\rreturn', 'nul\x00']:
            with self.assertRaises(ValueError):
                module.write_env(self.path, {'KEY': unsafe}, '')
            self.assertEqual(self.path.read_text(), 'EXISTING=keep\n')
        self.assertEqual(list(self.root.glob('.env-bootstrap-*')), [])


class PilotModeTests(unittest.TestCase):
    """--pilot exists so a gym can start before it has a merchant account."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / '.env.example').write_text(
            'NODE_ENV=development\nPILOT_MODE=\nPROMPTPAY_ID=\nOTP_SECRET=\n', encoding='utf-8')
        self.path = self.root / '.env'

    def install_pilot(self):
        with patch.object(module, 'ask', side_effect=['owner@example.test', ADMIN_PASSWORD, ADMIN_PASSWORD]), \
                patch('builtins.open', return_value=MagicMock()):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root, pilot=True)
        return module.read_env(self.path)

    def test_pilot_asks_only_for_the_administrator(self):
        values = self.install_pilot()
        self.assertEqual(values['PILOT_MODE'], '1')
        self.assertEqual(values['ADMIN_EMAIL'], 'owner@example.test')
        self.assertEqual(values['ADMIN_PASSWORD'], ADMIN_PASSWORD)
        self.assertEqual(len(values['OTP_SECRET']), 64)
        self.assertEqual(values['APP_ORIGIN'], 'https://srv1979069.hstgr.cloud')
        self.assertEqual(values['NODE_ENV'], 'production')
        # The template's development default must not survive as something that
        # looks like configuration the app is quietly ignoring.
        self.assertEqual(values['PROMPTPAY_ID'], '')

    def test_clearing_the_admin_keeps_pilot_mode_on(self):
        self.install_pilot()
        # This is the second call bootstrap.sh makes after the first healthy
        # boot; dropping the flag there would take the gym live by accident.
        with contextlib.redirect_stdout(io.StringIO()):
            module.configure(self.root, clear_admin=True)
        values = module.read_env(self.path)
        self.assertEqual(values['PILOT_MODE'], '1')
        self.assertEqual(values['ADMIN_EMAIL'], '')
        self.assertEqual(values['ADMIN_PASSWORD'], '')

    def test_rerunning_without_pilot_collects_promptpay_and_goes_live(self):
        secret = self.install_pilot()['OTP_SECRET']
        with patch.object(module, 'ask', side_effect=['0812345678']), \
                patch('builtins.open', return_value=MagicMock()):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root)
        values = module.read_env(self.path)
        self.assertEqual(values['PILOT_MODE'], '')
        self.assertEqual(values['PROMPTPAY_ID'], '0812345678')
        # Changing this would invalidate every membership card already sent out.
        self.assertEqual(values['OTP_SECRET'], secret)

    def test_a_bad_promptpay_id_leaves_the_gym_in_pilot_mode(self):
        self.install_pilot()
        before = self.path.read_bytes()
        with patch.object(module, 'ask', side_effect=['not-an-id']), \
                patch('builtins.open', return_value=MagicMock()):
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'PromptPay'):
                    module.configure(self.root)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(module.read_env(self.path)['PILOT_MODE'], '1')

    def test_pilot_can_be_switched_back_on_without_touching_credentials(self):
        with patch.object(module, 'ask', side_effect=[
                'owner@example.test', ADMIN_PASSWORD, ADMIN_PASSWORD, '0812345678']), \
                patch('builtins.open', return_value=MagicMock()):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root)
        live = module.read_env(self.path)
        self.assertEqual(live['PILOT_MODE'], '')

        with patch.object(module, 'ask', side_effect=AssertionError('must not prompt')):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(self.root, pilot=True)
        back = module.read_env(self.path)
        self.assertEqual(back['PILOT_MODE'], '1')
        self.assertEqual(back['PROMPTPAY_ID'], live['PROMPTPAY_ID'])


class TerminalGuardTests(unittest.TestCase):
    """Every other test here replaces builtins.open outright, so the check that
    a terminal is attached never met one. It was wrong -- 'r+' cannot wrap
    anything unseekable, and a terminal never is -- and the suite stayed green
    while no installation could get past it. These open a real pty instead, so
    the mode is what is under test and not what the mock decided to allow.
    """

    def tty_open(self, fd):
        real_open = builtins.open

        def opener(file, *args, **kwargs):
            if file == '/dev/tty':
                return real_open(fd, *args, closefd=False, **kwargs)
            return real_open(file, *args, **kwargs)
        return opener

    def test_the_guard_accepts_an_actual_terminal(self):
        primary, secondary = os.openpty()
        self.addCleanup(os.close, primary)
        self.addCleanup(os.close, secondary)
        with patch('builtins.open', side_effect=self.tty_open(secondary)):
            module.require_terminal()

    def test_the_first_question_is_asked_on_an_actual_terminal(self):
        """The guard is only worth having where the installer actually runs."""
        primary, secondary = os.openpty()
        self.addCleanup(os.close, primary)
        self.addCleanup(os.close, secondary)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / '.env.example').write_text('OTP_SECRET=\n', encoding='utf-8')
        with patch('builtins.open', side_effect=self.tty_open(secondary)), \
                patch.object(module, 'ask', side_effect=['owner@example.test', ADMIN_PASSWORD, ADMIN_PASSWORD]):
            with contextlib.redirect_stdout(io.StringIO()):
                module.configure(root, pilot=True)
        self.assertEqual(module.read_env(root / '.env')['PILOT_MODE'], '1')

    def test_the_guard_still_refuses_when_there_is_no_terminal(self):
        def no_tty(file, *args, **kwargs):
            if file == '/dev/tty':
                raise OSError(6, 'No such device or address')
            raise AssertionError(f'unexpected open of {file}')
        with patch('builtins.open', side_effect=no_tty):
            with self.assertRaises(OSError):
                module.require_terminal()


if __name__ == '__main__':
    unittest.main()
