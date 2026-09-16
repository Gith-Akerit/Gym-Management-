-- A counter that only ever goes forwards.
--
-- The reference is the number the screen tells a member of staff to write
-- down, and the manual tells them to write it down. It was worked out as
-- `MAX(reference) + 1`, which counts the rows that are still there rather than
-- the numbers that have already been handed out: delete the newest report and
-- the next one is issued the same number. Nobody loses data, but "เรื่อง #2
-- ยังไม่ได้แก้" stops meaning one thing (QA REPORT-01).
--
-- A table rather than AUTOINCREMENT because the reference is not the primary
-- key here -- the id is a uuid, and SQLite's AUTOINCREMENT only applies to an
-- INTEGER PRIMARY KEY. One row per counter, and room for the next one.
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

-- Seeded past whatever this gym has already issued, so an upgrade never
-- reissues a number that is already written on somebody's notepad.
INSERT INTO counters(name, value)
  SELECT 'problem_report', COALESCE(MAX(reference), 0) FROM problem_reports;
