// Builds the list Randomize offers to copy when your own season list is empty.
//
// The group often ranks trailers together on ONE account, and a different
// account does the 1st episodes another day - with no list of its own, so its
// wheel is empty. Other accounts may also have ranked a trailer the shared one
// never saw, so their extras come along too. Pure, so the ordering rules are
// testable without a page (frontend/tests/copyList.test.ts).

export interface CopyEntry {
  mediaId: number;
  customName: string | null;
}

/** One account's list for the season, in its own `order`. */
export interface AccountList {
  user: string;
  entries: CopyEntry[];
}

export interface CopiedList {
  /** What gets saved, in order. */
  items: CopyEntry[];
  /**
   * Every other account that would add at least one show, with those shows -
   * excluded accounts too, so their checkbox stays on screen to tick again.
   */
  bonus: { user: string; mediaIds: number[] }[];
}

/** Most shows first; a tie goes to the name, so the order is stable. */
function byCount(a: AccountList, b: AccountList): number {
  return b.entries.length - a.entries.length || a.user.localeCompare(b.user);
}

/** The account a copy starts from unless you pick another: the biggest list. */
export function defaultMain(lists: AccountList[]): string | null {
  return [...lists].sort(byCount)[0]?.user ?? null;
}

/**
 * The main account's shows keep its order and nicknames. Every other account's
 * new shows follow as a block in that account's own order - never interleaved
 * with the main ranking - and get no nickname: nobody agrees on one, so the
 * main account is the only source of them. A show an earlier block already
 * holds is not repeated.
 */
export function buildCopiedList(
  lists: AccountList[],
  mainUser: string,
  excluded: Set<string>
): CopiedList {
  const main = lists.find((l) => l.user === mainUser);
  const seen = new Set<number>();
  const items: CopyEntry[] = [];
  for (const e of main?.entries ?? []) {
    if (seen.has(e.mediaId)) continue;
    seen.add(e.mediaId);
    items.push({ mediaId: e.mediaId, customName: e.customName ?? null });
  }

  const bonus: CopiedList['bonus'] = [];
  for (const list of lists.filter((l) => l.user !== mainUser).sort(byCount)) {
    // An excluded account still claims nothing, so a later account's copy of
    // the same show is listed (and saved) under that later account instead.
    const fresh = list.entries.map((e) => e.mediaId).filter((id) => !seen.has(id));
    const unique = [...new Set(fresh)];
    if (!unique.length) continue;
    bonus.push({ user: list.user, mediaIds: unique });
    if (excluded.has(list.user)) continue;
    for (const id of unique) {
      seen.add(id);
      items.push({ mediaId: id, customName: null });
    }
  }
  return { items, bonus };
}
