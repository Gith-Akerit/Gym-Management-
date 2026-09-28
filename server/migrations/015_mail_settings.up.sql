-- The gym's own mailbox, typed in by the owner rather than put in a file.
--
-- The gym has Office 365 and an address staff already read, `info@`, so the
-- letters go out through that mailbox instead of a third-party provider: no
-- new account, no monthly bill, and the recipient sees an address they would
-- recognise on a business card.
--
-- The password lives HERE and not in `.env` for one reason: the person who
-- knows it is the gym owner, and the only screen the gym owner can reach is
-- the app. Asking them to paste a mailbox password into a chat so a developer
-- can put it in a file is how that password ends up in three chat histories.
-- It is stored sealed with AES-256-GCM (server/secret-box.js); the key is in
-- `.env`, which the database backup does not carry.
--
-- One row, id=1, the same shape as gym_settings. A gym has one mailbox.
CREATE TABLE mail_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host TEXT NOT NULL DEFAULT 'smtp.office365.com',
  port INTEGER NOT NULL DEFAULT 587,
  -- Office 365 on 587 is STARTTLS: the connection opens in the clear and is
  -- upgraded before AUTH. Kept as a column rather than derived from the port
  -- because a gym that later moves to 465 needs implicit TLS instead.
  starttls INTEGER NOT NULL DEFAULT 1 CHECK (starttls IN (0, 1)),
  username TEXT NOT NULL DEFAULT '',
  -- Sealed, never the password itself. Empty means "not set yet", which is a
  -- different thing from "set to an empty string".
  password_sealed TEXT NOT NULL DEFAULT '',
  -- What recipients see. The name defaults to the gym's own name at send time,
  -- so a gym that renames itself does not have to remember this screen.
  from_email TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  -- The last time the "send a test letter" button was pressed and what came
  -- back. Written down so the screen can say "working as of Tuesday" instead
  -- of making the owner press it again to find out.
  tested_at INTEGER,
  test_ok INTEGER NOT NULL DEFAULT 0 CHECK (test_ok IN (0, 1)),
  test_detail TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO mail_settings(id) VALUES (1);

-- The member's welcome letter: the card, sent to them, the moment they join.
--
-- Written down so a second save does not post a second copy of the card, and
-- so the counter can see whether it went. The address itself is not here -- it
-- is on the users row the member is linked to, where it already was.
ALTER TABLE members ADD COLUMN welcome_sent_at INTEGER;

-- Reserved for the member portal in the next round: when the member was
-- invited to set a password for it. Added now, with the column the portal will
-- read, so that turning the portal on is not another migration on a live gym.
-- Nothing writes it yet.
ALTER TABLE members ADD COLUMN portal_invited_at INTEGER;
