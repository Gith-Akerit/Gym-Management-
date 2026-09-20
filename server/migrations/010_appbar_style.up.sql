-- Whether the app bar wears the gym's colour.
--
-- Off by default, and that is the whole reason this column exists rather than
-- the app simply doing it: most logos are drawn to sit on white, so a coloured
-- bar needs a white plate behind the logo, which is a box inside a box, and the
-- gym's name has to change colour with the background. A white bar with a 6px
-- brand line under it gets almost all of the effect and none of that
-- (Designer, ข้อ 5). A gym that wants the full colour turns it on and the
-- system works out the text colour for them.
ALTER TABLE gym_settings ADD COLUMN appbar_style TEXT NOT NULL DEFAULT 'light'
  CHECK (appbar_style IN ('light','brand'));

-- The average colour of the logo file, worked out once when it is uploaded.
--
-- It decides one thing: whether the logo needs a white plate behind it on the
-- card. Kept here rather than measured at draw time because every card render
-- would otherwise decode the logo a second time to answer a question whose
-- answer only changes when the file does.
ALTER TABLE gym_settings ADD COLUMN logo_avg TEXT;
