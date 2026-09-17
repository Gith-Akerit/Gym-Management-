-- The content a member reads: machines, programmes, articles.
--
-- Shaped around one fact from the Planner's file: every number in a programme
-- is an EXAMPLE until a trainer at this gym has looked at it. That is not a
-- note in a README, it is a column -- because a set of numbers that looks
-- reviewed and is not is exactly the thing that gets somebody hurt, and the
-- screen has to be able to say which it is looking at.
--
-- The long lists (steps, cautions, muscles, the body of an article) are stored
-- as JSON text rather than as child tables. They are read whole, written
-- whole, never queried into, and never joined against -- a child table would
-- buy ordering guarantees this does not need and cost a join on every page.

CREATE TABLE machines (
  code TEXT PRIMARY KEY,               -- M-01. Printed on the QR beside the machine.
  name_th TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'strength' CHECK (type IN ('cardio', 'strength')),
  muscles TEXT NOT NULL DEFAULT '[]',
  setup TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  cautions TEXT NOT NULL DEFAULT '[]',
  intensity_howto TEXT NOT NULL DEFAULT '',
  -- A public YouTube link the gym does not own. It can be taken down by
  -- somebody else at any moment, so the screen has to survive that -- and the
  -- owner has to be able to replace one without a deploy.
  video_url TEXT NOT NULL DEFAULT '',
  video_title TEXT NOT NULL DEFAULT '',
  video_channel TEXT NOT NULL DEFAULT '',
  -- The gym's own photograph of the machine. Bytes live under the machine
  -- store like every other upload; only the name is here.
  photo_stored_name TEXT,
  photo_content_type TEXT,
  photo_updated_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Who checked it, and when. NULL means nobody has.
  reviewed_by TEXT,
  reviewed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE programs (
  code TEXT PRIMARY KEY,
  name_th TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  for_whom TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  frequency_per_week TEXT NOT NULL DEFAULT '',
  minutes_per_session TEXT NOT NULL DEFAULT '',
  -- 1 until a trainer has been through the numbers. The programme screen says
  -- so out loud while it is 1, because "2 เซ็ต 12 ครั้ง" printed with the gym's
  -- name on it reads as instruction from the gym whether or not anybody meant
  -- it to (Planner, Mika).
  values_are_examples INTEGER NOT NULL DEFAULT 1 CHECK (values_are_examples IN (0, 1)),
  trainer_note TEXT NOT NULL DEFAULT '',
  progression TEXT NOT NULL DEFAULT '',
  next_program TEXT NOT NULL DEFAULT '',
  stations TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE articles (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

-- The safety wording, which is three blocks of text the gym is responsible for
-- rather than the team. One row, like every other single-row settings table.
--
-- `approved_by` is the point of it: this is advice the gym gives its members,
-- so it carries the gym's name and needs the owner's press before it is shown
-- as theirs.
CREATE TABLE safety_notices (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  portal_home_title TEXT NOT NULL DEFAULT '',
  portal_home TEXT NOT NULL DEFAULT '[]',
  machine_footer TEXT NOT NULL DEFAULT '[]',
  program_before_start TEXT NOT NULL DEFAULT '[]',
  approved_by TEXT,
  approved_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO safety_notices(id) VALUES (1);
