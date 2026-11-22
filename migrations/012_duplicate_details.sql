-- What a duplicate finding's files weigh and when they were last changed, and
-- which series/movie folder they are in — so "delete all the extra copies" can
-- keep the newest file of each group.
ALTER TABLE duplicate_findings ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
