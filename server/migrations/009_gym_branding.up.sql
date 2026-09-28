-- The gym's own look: its logo and its colours.
--
-- Separate from gym_profile on purpose. That table is the gym's facts -- its
-- name, phone, address, opening hours -- and it is edited on a screen about
-- facts. This one is what those facts are dressed in, and the owner changes it
-- once and then almost never again. Putting the colours in gym_profile would
-- have meant one more thing to get wrong on the screen staff use weekly.
--
-- One row, like gym_profile, because there is one gym.
CREATE TABLE gym_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),

  -- What goes in the small square on the card and in the app bar when there is
  -- no logo file. Empty means "work it out from the gym's name", which is what
  -- the card has always done.
  brand_short TEXT NOT NULL DEFAULT '',

  -- The logo, stored the way slips and member photographs are: outside the web
  -- root, under a name the server chose. Unlike those two it is not personal
  -- data -- it is a shop sign -- so it is served without a session, because the
  -- login screen has to show it before anybody has one.
  logo_stored_name TEXT,
  logo_content_type TEXT,
  logo_updated_at INTEGER,

  -- Exactly six hex digits, checked here as well as in the API: a colour that
  -- is not a colour ends up as a transparent header on a member's card, and by
  -- then nobody remembers which screen let it through.
  color_primary TEXT NOT NULL DEFAULT '#05603A'
    CHECK (color_primary GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  -- NULL means "work one out from the primary", which is the normal case: the
  -- owner picks one colour off their sign and stops thinking about it.
  color_secondary TEXT
    CHECK (color_secondary IS NULL OR color_secondary GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),

  -- Printed at the bottom of the card beside the phone number. The gym's phone
  -- and address already live in gym_profile and are already on the card, so
  -- they are not repeated here.
  line_id TEXT NOT NULL DEFAULT '',

  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

-- The row exists from the first boot, so every read is a read and only writes
-- have to think about whether there is anything there.
INSERT INTO gym_settings(id, updated_at)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
