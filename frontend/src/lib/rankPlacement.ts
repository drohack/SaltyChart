// Pure reorder helpers shared by the Watched rail (WatchedRankingSidebar) and
// the expanded ranking (RankingExpanded), so both place and drag a show the
// same way and save through the same parent handler.

/**
 * Move the item at `from` so it ends up in front of what is now at `to`
 * (`to === list.length` means "last"). Returns the new array, or null when
 * nothing would change - callers skip the save then.
 */
export function moveIndex<T>(list: T[], from: number, to: number): T[] | null {
  if (from < 0 || from >= list.length || to < 0 || to > list.length) return null;
  const dest = from < to ? to - 1 : to;
  if (dest === from) return null;
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(dest, 0, item);
  return out;
}

/** The `to` for moveIndex that shifts index `i` one place up (d < 0) or down. */
export function nudgeTarget(i: number, d: number, length: number): number | null {
  if (d < 0 && i > 0) return i - 1;
  if (d > 0 && i < length - 1) return i + 2;
  return null;
}
