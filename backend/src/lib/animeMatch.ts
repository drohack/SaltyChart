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
  /** Display only (the admin lookup shows it); never matched on. */
  year?: number | null;
  /**
   * Also from the library's metadata. Jellyfin carries `Tmdb` on ~99% of both
   * series and movies, and it is the only usable id for films — TVDB is a *TV*
   * database and covers 4 of 117 corpus movies against TMDB's 43.
   */
  tmdbId?: string | null;
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
  /** Which fuzzy tier hit: 0 exact, 1 prefix. Only for `title`. */
  tier?: 0 | 1;
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
 * direction, e.g. "Frieren" vs "Frieren: Beyond Journey's End").
 * Within a tier the shortest library title wins (least extra noise).
 *
 * Length floors matter: an all-Japanese title can normalize to almost nothing
 * — see normalizeTitle — and a 1-char prefix candidate happily matched
 * "30 Rock", so candidates shorter than 4 normalized chars only count for
 * exact matches.
 *
 * **There is deliberately no contains-anywhere tier.** There was one, guarded
 * by `shorter >= 6 && ratio >= 0.4`, and measured against the real library
 * (2271 series) across 6 seasons of AniList data (696 shows) it fired 9 times
 * and was wrong all 9:
 *
 *   Agents of the Four Seasons  → The Four Seasons (2025)   [live-action comedy]
 *   Record of Ragnarok III      → Ragnarok                  [Norwegian drama]
 *   Kingdom Season 6            → The 10th Kingdom          [2000 miniseries]
 *   Koisuru ONE PIECE           → One Piece                 [different series]
 *   HEAD START AT BIRTH         → Monogatari
 *   …and four spin-offs/movies pointed at the TV series they are named after.
 *
 * The failure is structural, not a bad constant — the *Four Seasons* pair sat
 * at exactly the 0.4 floor while two correct-looking ones sat above it, so no
 * threshold separates them. A short standalone title appearing somewhere
 * inside a longer, different one is simply not evidence: "Ragnarok" is inside
 * "Record of Ragnarok" for the same reason "Kingdom" is inside "The 10th
 * Kingdom". Prefix already covers the case that legitimately needs fuzz — a
 * shared beginning with a subtitle appended — which is why it keeps its 61
 * matches while this tier kept none. Don't reintroduce it with a higher
 * threshold; re-run the measurement instead.
 */
export function matchByTitle(
  candidates: string[],
  library: MatchableSeries[]
): { series: MatchableSeries; tier: 0 | 1 } | null {
  let best: { tier: 0 | 1; series: MatchableSeries } | null = null;
  for (const cand of expandCandidates(candidates)) {
    const nc = normalizeTitle(cand);
    if (!nc) continue;
    for (const s of library) {
      let tier: 0 | 1 | null = null;
      for (const sn of s.norms) {
        const shorter = Math.min(sn.length, nc.length);
        const ratio = shorter / Math.max(sn.length, nc.length);
        let t: 0 | 1 | null = null;
        if (sn === nc) t = 0;
        // Prefix: ratio guard kills e.g. library "Aria" (4) matching candidate
        // "ariathescarletammo" (18); 0.25 still admits "frieren" (7) vs
        // "frierenbeyondjourneysend" (24).
        else if (shorter >= 4 && ratio >= 0.25 && (sn.startsWith(nc) || nc.startsWith(sn))) t = 1;
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
 * **A known id is authoritative in BOTH directions.** If the caller supplies an
 * id and no library series carries it, that is the answer — we do not fall back
 * to titles. This is the single rule that fixed the "franchise sibling" class,
 * and it replaced three weeks of threshold tuning.
 *
 * Measured over 8 seasons (945 entries) against the real 2271-series library:
 * the title tier, graded blind against the id tier, was 99% precise on exact
 * matches (205/207) but only **60% on prefix matches (18/30)**. All 12 prefix
 * failures were the same shape — a new work matched onto the franchise parent:
 *
 *   Pokémon Concierge          → Pokémon                     (S20E109!)
 *   SAO Alternative: Gun Gale  → Sword Art Online
 *   Nanoha EXCEEDS (2026)      → Magical Girl Lyrical Nanoha (2004)
 *   Seven Deadly Sins: Four Knights of the Apocalypse → The Seven Deadly Sins
 *
 * **Every one of those 12 already had a TVDB id, and in every case the library
 * did not hold it** — we knew the right answer and let the fuzzy matcher
 * overwrite it. Rejecting instead costs nothing: the 18 *correct* matches in
 * that bucket were all found by id anyway, so the title tier contributed
 * exactly zero of them.
 *
 * Nothing cheaper works, and both obvious ideas were tested and refuted:
 * - **Season/episode count of the library series does not separate them.**
 *   Bleach (26 seasons) is a correct match; Pokémon (23) is wrong; Mononoke (1)
 *   is wrong; Dorohedoro (2) is right. The ranges overlap completely.
 * - **Neither does the text.** "BLEACH: Thousand-Year Blood War" (right) and
 *   "SAO Alternative: Gun Gale Online" (wrong) are the same shape — parent
 *   title plus a distinctive subtitle. An arc name and a spin-off name are
 *   indistinguishable as strings.
 *
 * Residual risk, stated so it is not rediscovered as a surprise: if the id were
 * *wrong* and the library held the show under a different id, we now say "not in
 * library" where titles would have found it. Zero such cases in the corpus. The
 * `SeriesIdentity` override table is the permanent fix when one appears.
 *
 * Title matching remains permanent for entries with **no id at all** — 65 of the
 * corpus resolved that way and nothing else could have found them.
 */
export function matchSeries(
  entry: {
    tvdbId?: string | null;
    tmdbId?: string | null;
    titles: string[];
    /**
     * May an id *miss* end the lookup?
     *
     * True (the default) for ids we trust outright: the community map, and rows
     * a human confirmed on /admin/matching. Those carry negative evidence — see
     * the note above.
     *
     * **False for ids the remote resolver guessed.** Those are positive-only:
     * they may add a match, never remove one. Without this an unverified TMDB
     * search result could suppress a *working* title match, because many of the
     * entries the resolver touches are precisely the ones that resolve by title
     * today. That would reintroduce the failure class this file exists to
     * remove, just from a different direction.
     */
    idIsAuthoritative?: boolean;
  },
  library: MatchableSeries[]
): MatchResult | null {
  const wantTvdb = entry.tvdbId ? String(entry.tvdbId) : null;
  const wantTmdb = entry.tmdbId ? String(entry.tmdbId) : null;
  if (wantTvdb || wantTmdb) {
    const hit = library.find(
      (s) =>
        (wantTvdb != null && s.tvdbId != null && String(s.tvdbId) === wantTvdb) ||
        (wantTmdb != null && s.tmdbId != null && String(s.tmdbId) === wantTmdb)
    );
    if (hit) return { series: hit, confidence: 'id' };
    // Negative evidence — see the note above. Do NOT "improve" this by adding a
    // title fallback; that is precisely the bug it exists to remove.
    if (entry.idIsAuthoritative !== false) return null;
    // …unless the id was a guess, in which case fall through to titles.
  }
  const fuzzy = matchByTitle(entry.titles, library);
  return fuzzy ? { series: fuzzy.series, confidence: 'title', tier: fuzzy.tier } : null;
}
