// ---------------------------------------------------------------------------
// Matching AniList entries to a media library.
//
// Pure functions only — no HTTP, no database, no config. That keeps them
// unit-testable without a running server and reusable by anything that needs
// to resolve an AniList entry against a list of series (the availability
// lookup today; a Sonarr sync later).
//
// The id lookup itself lives in `anilistTvdbMap.ts` because it does I/O; the
// caller resolves an AniList id to a TVDB id there and hands it in here.
// ---------------------------------------------------------------------------

/**
 * A series from whatever library we're matching against. Deliberately
 * structural: `matchSeries` never touches anything server-specific, so the
 * same code works against Jellyfin items, Plex shows, or a Sonarr lookup.
 */
export interface MatchableSeries {
  /** The library's own id (Jellyfin ItemId, Plex ratingKey, …). */
  id: string;
  title: string;
  /** Normalized `title` plus, when present, the native-script original title. */
  norms: string[];
  /** From the library's own metadata, when it has one. */
  tvdbId?: string | null;
}

export interface MatchResult {
  series: MatchableSeries;
  /**
   * How we got here. `id` means an AniList → TVDB → library-id chain, which is
   * exact. `title` means fuzzy string matching, which is right most of the
   * time but produced a real false positive in testing (AniList's 2026
   * "Mahou Shoujo Lyrical Nanoha EXCEEDS" matching a 2004 library entry), so
   * callers should treat it as unconfirmed rather than fact.
   */
  confidence: 'id' | 'title';
  /** Which fuzzy tier hit: 0 exact, 1 prefix, 2 contains. Only for `title`. */
  tier?: 0 | 1 | 2;
}

/**
 * Lowercase, strip diacritics, drop punctuation/whitespace — but KEEP
 * letters/digits of every script. Stripping to [a-z0-9] reduced an
 * all-Japanese title like 「転生貴族、鑑定スキルで成り上がる 第3期」 to
 * just "3", which then garbage-matched short English titles.
 */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

/**
 * Expand title candidates with season-suffix-stripped variants so sequels
 * match their base series ("… 3rd Season" → "…"), which is where the library
 * keeps the episodes anyway.
 */
export function expandCandidates(candidates: string[]): string[] {
  const out = new Set<string>();
  for (const cand of candidates) {
    out.add(cand);
    const stripped = cand
      .replace(/\s*[:\-–]?\s*(\d+(st|nd|rd|th)\s+season|season\s+\d+|part\s+\d+|cour\s+\d+)\s*$/i, '')
      .replace(/\s*第\s*\d+\s*(期|クール|シーズン)\s*$/u, '')
      .trim();
    if (stripped && stripped !== cand) out.add(stripped);
  }
  return [...out];
}

/**
 * Tiered fuzzy match across all title candidates: exact > prefix (either
 * direction, e.g. "Frieren" vs "Frieren: Beyond Journey's End") > contains.
 * Within a tier the shortest library title wins (least extra noise).
 *
 * Length floors matter: an all-Japanese title normalizes to almost nothing
 * (e.g. 「転生貴族、鑑定スキルで成り上がる 第3期」 → "3"), and a 1-char
 * prefix candidate happily matched "30 Rock". Candidates shorter than 4
 * normalized chars only count for exact matches.
 */
export function matchByTitle(
  candidates: string[],
  library: MatchableSeries[]
): { series: MatchableSeries; tier: 0 | 1 | 2 } | null {
  let best: { tier: 0 | 1 | 2; series: MatchableSeries } | null = null;
  for (const cand of expandCandidates(candidates)) {
    const nc = normalizeTitle(cand);
    if (!nc) continue;
    for (const s of library) {
      let tier: 0 | 1 | 2 | null = null;
      for (const sn of s.norms) {
        const shorter = Math.min(sn.length, nc.length);
        const ratio = shorter / Math.max(sn.length, nc.length);
        let t: 0 | 1 | 2 | null = null;
        if (sn === nc) t = 0;
        // Prefix: ratio guard kills e.g. library "Aria" (4) matching candidate
        // "ariathescarletammo" (18); 0.25 still admits "frieren" (7) vs
        // "frierenbeyondjourneysend" (24).
        else if (shorter >= 4 && ratio >= 0.25 && (sn.startsWith(nc) || nc.startsWith(sn))) t = 1;
        // Contains-anywhere is the loosest tier — a short title appears as a
        // substring of unrelated long ones ("aria" inside "…nariagaru…"), so
        // it needs the strictest guards.
        else if (shorter >= 6 && ratio >= 0.4 && (sn.includes(nc) || nc.includes(sn))) t = 2;
        if (t !== null && (tier === null || t < tier)) tier = t;
      }
      if (tier === null) continue;
      if (
        !best ||
        tier < best.tier ||
        (tier === best.tier && s.title.length < best.series.title.length)
      ) {
        best = { tier, series: s };
      }
    }
  }
  return best ? { series: best.series, tier: best.tier } : null;
}

/**
 * Which season does the AniList entry refer to? Parsed from title markers
 * ("2nd Season", "Season 2", 「第2期」). Null = no marker (season 1 / only
 * season / movie).
 */
export function detectSeasonNumber(titles: string[]): number | null {
  for (const t of titles) {
    const m =
      t.match(/(\d+)(?:st|nd|rd|th)\s+season/i) ||
      t.match(/season\s+(\d+)/i) ||
      t.match(/第\s*(\d+)\s*期/u);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 50) return n;
    }
  }
  return null;
}

/**
 * Resolve one AniList entry against the library.
 *
 * The TVDB id (when the caller has one — see `anilistTvdbMap.ts`) is tried
 * first because it is exact. It is NOT a replacement for the fuzzy tier:
 * measured over a full season, the id tier matched a strict *subset* of what
 * titles matched — it adds no reach, only certainty. Community AniList→TVDB
 * coverage is a function of how long a season has been airing (~55% two
 * months out, ~94% once finished), so title matching stays permanently.
 */
export function matchSeries(
  entry: { tvdbId?: string | null; titles: string[] },
  library: MatchableSeries[]
): MatchResult | null {
  if (entry.tvdbId) {
    const want = String(entry.tvdbId);
    const hit = library.find((s) => s.tvdbId && String(s.tvdbId) === want);
    if (hit) return { series: hit, confidence: 'id' };
  }
  const fuzzy = matchByTitle(entry.titles, library);
  return fuzzy ? { series: fuzzy.series, confidence: 'title', tier: fuzzy.tier } : null;
}
