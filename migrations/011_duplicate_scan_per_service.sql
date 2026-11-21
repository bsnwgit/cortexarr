-- Duplicate-file scans move onto the Sonarr and Radarr services themselves
-- (migration 010 had made them a separate "library" service type, which is no
-- longer created — the 'library' value stays in the CHECK list because SQLite
-- can't drop one, but nothing writes it).
--
-- A Sonarr/Radarr service's scan is configured as JSON in `duplicate_scan`:
-- enabled, the SSH host/user/port/key path to reach the machine that holds its
-- files, the folders to scan there, and how often. Nothing in it is a secret
-- (the key is a path, never its contents).
ALTER TABLE service_instances ADD COLUMN duplicate_scan TEXT NOT NULL DEFAULT '{}';

-- Why the last scan failed, if it did — the findings from the last good scan
-- are kept meanwhile, so a flaky SSH link doesn't clear real duplicates.
ALTER TABLE library_scans ADD COLUMN error TEXT NOT NULL DEFAULT '';
