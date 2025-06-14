-- 2025-06-14  Add watchedRank column to WatchList for user-defined ranking

ALTER TABLE WatchList ADD COLUMN watchedRank INTEGER;

-- Seed existing watched rows so their rank corresponds to watchedAt order
-- Lowest number (0) = oldest watched

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY userId, season, year ORDER BY watchedAt) - 1 AS rnk
  FROM WatchList
  WHERE watched = 1
)
UPDATE WatchList
SET watchedRank = (SELECT rnk FROM ranked WHERE ranked.id = WatchList.id)
WHERE id IN (SELECT id FROM ranked);
