-- SQLite can drop a column since 3.35, and nothing references this one.
ALTER TABLE gym_settings DROP COLUMN appbar_style;
ALTER TABLE gym_settings DROP COLUMN logo_avg;
