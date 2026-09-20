-- A fourth kind of one-time link, and room for the diagnosis on the mail screen.
--
-- The token table is rebuilt rather than altered because its CHECK has to learn
-- a fourth value and SQLite cannot widen a CHECK in place. Safe here for the
-- same reasons as last time: nothing in the schema references this table, it
-- holds at most a handful of live rows, and every row in it is a link that is
-- about to expire anyway.
CREATE TABLE password_setup_tokens_new (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  issued_by TEXT REFERENCES users(id),
  -- setup:  issued at a terminal, a day, for an account with no password.
  -- reset:  asked for at the login screen, thirty minutes, because the person
  --         who asked is waiting for it right now.
  -- verify: proves the address in a sign-up is reachable by whoever typed it.
  -- member: goes out with a member's card. Seven days, because it arrives while
  --         they are walking out of the gym with a new membership and they will
  --         open it that evening at the earliest -- and a member who misses it
  --         has to come back to the counter to be sent another.
  purpose TEXT NOT NULL DEFAULT 'setup' CHECK (purpose IN ('setup', 'reset', 'verify', 'member'))
) STRICT;
INSERT INTO password_setup_tokens_new
  SELECT token_hash, user_id, created_at, expires_at, used_at, issued_by, purpose
  FROM password_setup_tokens;
DROP TABLE password_setup_tokens;
ALTER TABLE password_setup_tokens_new RENAME TO password_setup_tokens;
CREATE INDEX password_setup_user ON password_setup_tokens(user_id, expires_at);

-- What the mail server actually said, word for word, kept for the panel that
-- folds it away under "ส่งต่อให้ฝ่ายไอที". It is not shown first because a gym
-- owner who reads `535 5.7.139 SmtpClientAuthentication is disabled` closes the
-- page and telephones us (Designer) -- but sometimes it does have to be
-- forwarded, and then it has to be there.
ALTER TABLE mail_settings ADD COLUMN test_raw TEXT NOT NULL DEFAULT '';
-- Which of the three groups the last failure fell into, so the screen draws the
-- right set of steps after a reload rather than only in the moment.
ALTER TABLE mail_settings ADD COLUMN test_reason TEXT NOT NULL DEFAULT '';
