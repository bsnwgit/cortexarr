-- macOS "._name" metadata files a scan came across (and ignores as duplicates):
-- how many, in which library folders, and a few examples — so the Duplicates
-- page can offer a cleanup command for them.
ALTER TABLE library_scans ADD COLUMN junk TEXT NOT NULL DEFAULT '{}';
