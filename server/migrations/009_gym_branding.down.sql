-- The logo file on disk is not deleted here: rolling a schema back is not a
-- decision to throw away the picture the owner uploaded. It is left in the data
-- directory, and re-running the migration finds it again only if the row is
-- restored from a backup.
DROP TABLE gym_settings;
