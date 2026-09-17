-- What somebody at the counter says is wrong, with a picture of it.
--
-- The gym is one room with two or three people in it and no help desk. When
-- the screen does something unexpected at 19:00 with a member waiting, the
-- report that gets written is the one that takes ten seconds -- so the screen
-- takes its own picture and asks one question.
--
-- The screenshot is NOT an image of the system. It is an image of whatever was
-- on the screen, which is usually a member: their name, their photograph, their
-- telephone number. That is personal data and the reason `image_stored_name`
-- is served only to an administrator and every viewing is written down.
CREATE TABLE problem_reports (
  id TEXT PRIMARY KEY,
  -- Short and human, printed on the screen after sending ("เรื่อง #24") so a
  -- conversation about it does not have to quote a UUID.
  reference INTEGER NOT NULL UNIQUE,

  -- The only thing the person has to type. A picture on its own rarely says
  -- what they were trying to do.
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),

  -- Where it happened. Filled in by the screen; typed by the reporter only
  -- when the capture failed and there is nothing else to go on.
  screen TEXT NOT NULL DEFAULT '',

  -- Who reported it. Kept even if the account is later removed, because a
  -- report with no reporter cannot be followed up -- hence no cascade.
  reported_by TEXT REFERENCES users(id),

  -- The machine, so "only on the tablet" stops being a guess. Trimmed by the
  -- server: a user agent is long and none of the tail is useful here.
  user_agent TEXT NOT NULL DEFAULT '',
  viewport TEXT NOT NULL DEFAULT '',
  -- The build that was running. Half of any report arrives after the next
  -- deploy, and without this nobody can tell which screen it describes.
  app_revision TEXT NOT NULL DEFAULT '',

  -- NULL when the capture failed or the reporter turned it off, which is a
  -- normal report and not a broken one.
  image_stored_name TEXT,
  image_content_type TEXT,

  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reading','done','not_a_bug')),
  -- What the owner writes to themselves. The reporter never sees it.
  internal_note TEXT NOT NULL DEFAULT '',

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX problem_reports_status ON problem_reports(status, created_at DESC);
CREATE INDEX problem_reports_created ON problem_reports(created_at DESC);
