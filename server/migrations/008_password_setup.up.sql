-- A way back in for an account that has no password.
--
-- The gym on the real server was installed before passwords existed: the
-- owner's account is there, it is an admin, and it opens nothing. Reinstalling
-- would take their members with it, and handing out a password over chat is how
-- passwords end up in chat histories. So somebody with shell access issues a
-- link, the owner opens it once, types a password, and the link dies.
--
-- Stateful on purpose, unlike the card link: "once" cannot be signed.
CREATE TABLE password_setup_tokens (
  -- The SHA-256 of the token in the link. The link itself is never stored, so
  -- a copy of this table is not a set of working links.
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  -- Who asked for it, when there was somebody to ask. A link issued at the
  -- terminal has no signed-in actor, and NULL says exactly that.
  issued_by TEXT REFERENCES users(id)
) STRICT;
CREATE INDEX password_setup_user ON password_setup_tokens(user_id, expires_at);
