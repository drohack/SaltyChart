<script lang="ts">
  import { onMount } from 'svelte';
  import ExternalIdLink from '../components/ExternalIdLink.svelte';
  import { authToken } from '../stores/auth';
  import { apiJson, QUICK, ApiError } from '../lib/remote';
  import AdminShell from '../components/AdminShell.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import StatusChips from '../components/StatusChips.svelte';
  import SonarrEntryRow from '../components/SonarrEntryRow.svelte';
  import {
    LEVEL,
    LEVELS,
    byLevel,
    chipMatches,
    needsAttention as isAttention,
    type Chip,
    type EntryStatus,
  } from '../lib/entryStatus';

  /**
   * What is about to be added to Sonarr, and what already was?
   *
   * This page exists because the job is otherwise unobservable: it runs daily,
   * unattended, and it writes to someone else's library. Before this the only
   * way to see what it would do was a terminal command.
   *
   * It answers a different question from `/admin/matching`, which is why it is a
   * different page. That one asks **identity** - which real series is this,
   * permanently. This one asks **scope** - do we auto-add it, and what is about
   * to be grabbed. They share one thing: the status of each show, decided once
   * on the server (`backend/src/lib/entryStatus.ts`) and rendered the same way
   * on both pages, so a problem cannot read differently depending on which page
   * you open. A row whose problem is the match links across (*Fix match*).
   *
   * **Nothing actionable is collapsed.** Needs attention sits at the top, every
   * wanted show is in its season's table worst-first, and what a rule skipped
   * has its own always-open section. Problems used to live in a "Not on the
   * list" accordion, a waiting accordion per season and the bottom of the push
   * history, which is where a bad id went unnoticed.
   *
   * **The size estimate is a median, not a promise.** 0.38 GB/episode measured
   * 2026-08-04 over a random 500-episode sample of the live library; the
   * distribution has a long tail, hence the p90 alongside it.
   */

  const GB_MEDIAN = 0.38;
  const GB_P90 = 1.35;
  /** AniList leaves `episodes` null on plenty of unaired entries. Labelled, never hidden. */
  const ASSUMED_EPISODES = 12;

  const ENGLISH_TIP =
    'English subtitles or dub on the episodes Sonarr holds - green when every episode has one, red when some or all do not. Blank when Sonarr does not hold the show.';

  /** Problems fixed by correcting the match; they link to /admin/matching. */
  const MATCH_CODES = new Set([
    'noId', 'guess', 'ambiguous', 'titleOnly', 'unconfirmedAuto', 'viewerPick',
    'sonarrRejected', 'noTvdbId', 'unverifiedListed', 'unverifiedMatch', 'duplicateTvdbId',
  ]);

  /**
   * Every state gets a *visible* badge, including the boring ones.
   *
   * The first version badged only "will be added" and left the rest as plain
   * text, so a table of 39 rows read as 36 blanks and 3 highlights - you could
   * not tell "already held" from a rendering failure. If a cell means
   * something, it looks like something.
   */
  const STATE: Record<string, { label: string; cls: string }> = {
    willBeAdded: { label: 'will be added', cls: 'badge-warning' },
    // Two states, one meaning, and both are needed. `pushedAlready` is our own
    // record - precise, and the only one that survives a deletion, so a series
    // we added and you removed keeps saying "added". `addedByUs` is the marker
    // tag in Sonarr - it survives losing the database, which our record does not.
    //
    // It must be the MARKER tag, not any of our tags: we apply `anime` too, and
    // `anime` is on 692 series here, so "any tag" claimed shows the owner had
    // for years.
    pushedAlready: { label: 'added by us', cls: 'badge-success' },
    addedByUs: { label: 'added by us', cls: 'badge-success' },
    heldAlready: { label: 'already held', cls: 'badge-outline opacity-70' },
    excludedInSonarr: { label: 'excluded in Sonarr', cls: 'badge-outline opacity-50' },
    // Both mean nothing was added and both retry, so they are warnings rather
    // than errors - but `lookupFailed` is actionable on /admin/matching, and
    // saying so is the difference between a fixable row and a mystery.
    lookupFailed: { label: 'bad TVDB id', cls: 'badge-error badge-outline' },
    failed: { label: 'add failed', cls: 'badge-error badge-outline' },
    unknown: { label: 'not checked', cls: 'badge-outline opacity-40' },
  };

  /**
   * How well we know each match, in the same vocabulary /admin/matching uses.
   *
   * Computed by `matchGrade` in lib/seriesIdentity.ts - one definition, shared
   * with the Watch pop-up's correction picker, so the two pages cannot drift on
   * what "certain" means. The warning colours are the ones that matter: a `weak`
   * id was accepted on title text or a coincidental year, which is the class
   * that once offered Echo a namesake 1,012 days from its premiere.
   */
  const GRADE: Record<string, { label: string; cls: string }> = {
    confirmed: { label: 'confirmed', cls: 'badge-outline opacity-70' },
    adminOverride: { label: 'admin', cls: 'badge-outline opacity-70' },
    map: { label: 'map', cls: 'badge-outline opacity-70' },
    dateVerified: { label: 'date ok', cls: 'badge-outline opacity-70' },
    viewerPick: { label: 'viewer', cls: 'badge-warning badge-outline' },
    weak: { label: 'unverified', cls: 'badge-warning' },
    none: { label: 'no id', cls: 'badge-ghost opacity-50' },
  };

  /** The row awaiting an "include it anyway" decision, or null. */
  let confirming: { anilistId: number; title: string; grade: string; matchedTitle: string | null; note: string | null } | null = null;

  type Dated = { year?: number | null; month?: number | null; day?: number | null } | null;
  type Proposed = {
    tvdbId: number;
    title: string;
    anilistId: number | null;
    format: string | null;
    /** AniList airing status (`RELEASING`, `NOT_YET_RELEASED`, ...). */
    airing: string | null;
    startDate: Dated;
    season: string | null;
    year: number | null;
    cover: string | null;
    episodes: number | null;
    state: string;
    /** The one status (lib/entryStatus.ts on the server). Never computed here. */
    status: EntryStatus;
    wanted: boolean;
    wantedBy: 'rules' | 'list' | 'include' | null;
    onMyList: boolean;
    attention: boolean;
    watchable: boolean | null;
    /** Not out yet - Randomize hides it, but it is not red here for that. */
    unaired: boolean;
    grade: string;
    unverified: boolean;
    matchedTitle: string | null;
    gradeNote: string | null;
    /** From the last library check; null when Sonarr does not hold it or no check has seen it. */
    english?: { label: string; ok: boolean } | null;
    /** Trusted users with this on their list, when that is why it is on the list. */
    listedBy?: number;
    /** `lastSeason` = a sequel; Sonarr monitors only the newest season. */
    monitor?: 'firstSeason' | 'lastSeason';
  };
  type Rejected = {
    anilistId: number | null;
    /** Null on a `noUsableTvdbId` row - that is the point of the row. */
    tvdbId: number | null;
    episodes: number | null;
    title: string | null;
    format: string | null;
    startDate: Dated;
    season: string | null;
    year: number | null;
    cover: string | null;
    reason: string;
    parent: { title: string | null; tvdbId: number; held: boolean } | null;
    grade: string;
    unverified: boolean;
    matchedTitle: string | null;
    gradeNote: string | null;
    english?: { label: string; ok: boolean } | null;
    airing: string | null;
    status: EntryStatus;
    wanted: boolean;
    wantedBy: 'rules' | 'list' | 'include' | null;
    listedBy?: number;
    onMyList: boolean;
    attention: boolean;
    watchable: boolean | null;
    unaired: boolean;
  };
  type Push = {
    tvdbId: number;
    anilistId: number | null;
    title: string;
    status: 'pushed' | 'alreadyHeld' | 'lookupFailed' | 'failed';
    sonarrSeriesId: number | null;
    pushedAt: string | null;
    attempts: number;
    lastAttemptAt: string | null;
    lastError: string | null;
    /** A failure its show has moved past (re-matched, or added under another id). */
    superseded?: boolean;
  };
  /** What one episode offers an English speaker - `lib/libraryAudit.ts` decides it. */
  type SubState = 'fullEng' | 'signsOnly' | 'engAudio' | 'none' | 'unknown';
  type LibProblem = {
    season: number;
    episode: number;
    title: string;
    sub: SubState;
    stale: boolean;
    releaseGroup: string | null;
    quality: string | null;
    audio: string | null;
  };
  type LibRow = {
    sonarrId: number;
    tvdbId: number;
    title: string;
    titleSlug: string | null;
    qualityProfileId: number | null;
    jellyfinId: string | null;
    state: 'stale' | 'missing' | 'unknown' | 'allSubbed' | 'error';
    error?: string;
    audit?: {
      source: 'jellyfin' | 'sonarr';
      episodes: number;
      counts: Record<SubState, number>;
      /** Episodes with English audio. Absent on a check stored before dubs were counted. */
      dubbed?: number;
      stale: number;
      problems: LibProblem[];
    };
  };
  type LibraryAudit = {
    at: string;
    trigger: 'visit' | 'admin';
    rows: LibRow[];
    totals: {
      series: number;
      episodes: number;
      counts: Record<SubState, number>;
      dubbed?: number;
      stale: number;
      seriesStale: number;
      seriesMissing: number;
      unmatched: number;
      errors: number;
    };
    refresh: {
      requested: { jellyfinId: string; title: string }[];
      failed: { jellyfinId: string; title: string; error: string }[];
      settled: boolean;
      stillStale: string[];
      newSeries?: { scanned: string[]; found: string[]; stillMissing: string[]; error?: string };
    } | null;
  };
  type Report = {
    published: boolean;
    config: {
      configured: boolean;
      url: string;
      tags: string[];
      markerTag: string;
      taggedOfOurs: number;
      rootFolderPath: string;
      qualityProfileId: number;
      qualityProfileName: string | null;
      /** False is the setting that let raws stick. Null until a snapshot recorded the profiles. */
      qualityProfileUpgrades: boolean | null;
      profiles: { id: number; name: string; upgradeAllowed: boolean }[];
      seriesType: string;
      /** Setup steps still outstanding. Non-empty means a push cannot run. */
      problems: string[];
    };
    snapshot: { at: string; ok: boolean; seriesCount: number; error?: string; skipped?: string } | null;
    sonarr: { observed: boolean; held: number; excluded: number; at: string | null };
    history: {
      /** Ours by either record - a push row, or the marker tag in Sonarr. */
      ours: number;
      /** Marker-tagged and still held. Survives losing the database. */
      tagged: number;
      /** We have a record of adding these. Only a 201 from Sonarr produces one. */
      pushed: number;
      /** These were already in the library when we got here - NOT our doing. */
      alreadyHeld: number;
      needsAttention: number;
      firstPushAt: string | null;
      lastPushAt: string | null;
    };
    seasons: { season: string; year: number; cached: number }[];
    withinDays: number;
    proposed: Proposed[];
    rejected: Rejected[];
    pushes: Push[];
    orphans: { tvdbId: number; title: string; anilistId: number; nowTvdbId: number }[];
    /** Open failures no row in these seasons accounts for. */
    attention: { tvdbId: number; anilistId: number | null; title: string; status: string; lastError: string | null }[];
    summary: {
      attention: number; broken: number; check: number; waiting: number; ok: number;
      libraryAsked: number; libraryAnswered: number;
    };
    counts: { proposed: number; rejected: Record<string, number> };
    /** `last: null` is "never checked" - never render it as zero problems. */
    library: {
      last: LibraryAudit | null;
      lastError: string | null;
      lastAttemptAt: string | null;
      running: boolean;
    };
  };

  /** What a `POST /push` came back with. Rendered as a notice, not stored. */
  type PushResult = {
    ran: boolean;
    reason?: string;
    pushed: number;
    failed: number;
    deferred: number;
  };

  let report: Report | null = null;
  /** '' = fine. Non-empty renders instead of the page, so a failure is never a blank screen. */
  let loadError = '';
  let loading = true;
  let busy = '';
  let notice = '';

  $: auth = { Authorization: `Bearer ${$authToken}` };

  /**
   * Preview a season other than the served one.
   *
   * '' means "what is actually served" - the current season and the next.
   * Anything else is a what-if: it does not change what Sonarr receives, and
   * the banner says so, because a page that silently showed WINTER while
   * serving SUMMER would be worse than having no picker at all.
   */
  let preview = '';
  const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

  /**
   * The seasons offered for preview, derived rather than listed.
   *
   * Anchored on the years the server says it is serving, so it follows the
   * calendar on its own. A hardcoded `[2025, 2026, 2027]` sat here first and
   * would have stopped offering the current year in 2028 - the kind of literal
   * that works right up until it silently doesn't.
   */
  $: previewOptions = (() => {
    const years = (report?.seasons ?? []).map((s) => s.year);
    const anchor = years.length ? Math.min(...years) : new Date().getUTCFullYear();
    const out: string[] = [];
    for (let y = anchor - 1; y <= anchor + 1; y++) for (const s of SEASONS) out.push(`${s} ${y}`);
    return out;
  })();

  async function load() {
    if (!$authToken) return;
    loading = true;
    loadError = '';
    try {
      // Split here rather than in a `$:` statement. `on:change` runs `load()`
      // before Svelte flushes reactive declarations, so derived season/year
      // were still stale while `preview` was already set - which produced
      // `?season=&year=NaN` and a 400.
      const [ps, py] = preview.split(' ');
      const qs = preview ? `?season=${ps}&year=${py}` : '';
      report = await apiJson<Report>(`/api/sonarr/report${qs}`, { headers: auth }, {
        // Not QUICK: the report asks the library about every aired show (the
        // verdicts Randomize uses). Warm, that is instant; cold, it walks the
        // library and takes seconds.
        timeoutMs: 60_000,
        label: 'sonarr-report',
      });
    } catch (e) {
      // "Couldn't reach the backend" and "the backend said no" are different
      // things on screen, and telling them apart is the whole reason apiJson
      // surfaces ApiError.
      loadError =
        e instanceof ApiError && e.unreachable
          ? "Couldn't reach the backend."
          : 'Could not load the Sonarr report.';
    } finally {
      loading = false;
    }
  }

  async function post(path: string, body?: unknown, init: RequestInit = {}) {
    busy = path;
    notice = '';
    try {
      await apiJson(path, {
        method: init.method ?? 'POST',
        headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...init,
      }, { timeoutMs: QUICK, label: path });
      await load();
    } catch {
      notice = 'That did not go through. Nothing was changed.';
    } finally {
      busy = '';
    }
  }

  /**
   * Run the library check now, then follow any Jellyfin refresh it asked for.
   *
   * The server answers once the audit is stored and refreshes are requested;
   * whether Jellyfin actually caught up lands up to two minutes later, so the
   * page re-reads the report until the refresh settles rather than leaving a
   * "watching..." line on screen forever.
   */
  async function checkLibraryNow() {
    busy = 'library';
    notice = '';
    try {
      const r = await apiJson<Report['library'] & { status: string }>(
        '/api/sonarr/library/check',
        { method: 'POST', headers: auth },
        { timeoutMs: 90_000, retries: 0, label: 'sonarr-library-check' }
      );
      if (r.status === 'running') {
        notice = 'Already refreshing - the English column updates when it finishes.';
      } else if (r.lastError) {
        notice = `Could not refresh: ${r.lastError}`;
      } else {
        const n = r.last?.refresh?.requested.length ?? 0;
        notice = n
          ? `Jellyfin was behind on ${n} series - asked it to rescan them. English column updated.`
          : 'Jellyfin is up to date. English column updated.';
      }
      await load();
    } catch {
      notice = 'Could not refresh Jellyfin.';
    } finally {
      busy = '';
    }
    for (let i = 0; i < 9 && report?.library.last?.refresh && !report.library.last.refresh.settled; i++) {
      await new Promise((r) => setTimeout(r, 20_000));
      await load();
    }
  }

  /** Run the snapshot, then reload. Slow enough to need its own busy state. */
  async function snapshotNow() {
    busy = 'snapshot';
    notice = '';
    try {
      const s = await apiJson<Report['snapshot']>(
        '/api/sonarr/snapshot',
        { method: 'POST', headers: auth },
        { timeoutMs: 60_000, label: 'sonarr-snapshot' }
      );
      notice = s?.skipped
        ? `Snapshot changed nothing: ${s.skipped}`
        : `Snapshot ok - Sonarr holds ${s?.seriesCount ?? 0} series.`;
      await load();
    } catch {
      notice = 'The snapshot could not run.';
    } finally {
      busy = '';
    }
  }

  /**
   * Add the pending series now, rather than waiting for the daily job.
   *
   * The reply is reported in full, including the two "nothing happened"
   * answers - paused, and a setup problem. A button that silently does nothing
   * when the switch is off is how someone concludes the feature is broken.
   */
  async function pushNow() {
    busy = 'push';
    notice = '';
    try {
      const r = await apiJson<PushResult>(
        '/api/sonarr/push',
        { method: 'POST', headers: auth },
        { timeoutMs: 120_000, label: 'sonarr-push' }
      );
      if (!r.ran) {
        notice =
          r.reason === 'paused'
            ? 'Nothing was added - pushing is paused.'
            : `Nothing was added: ${r.reason}`;
      } else {
        const bits = [`${r.pushed} added`];
        if (r.failed) bits.push(`${r.failed} failed`);
        // Stated even when zero would have been the friendlier number: "10 left
        // for tomorrow" and "all done" must never look the same.
        if (r.deferred) bits.push(`${r.deferred} left for the next run`);
        notice = bits.join(', ') + '.';
      }
      await load();
    } catch {
      notice = 'The push could not run.';
    } finally {
      busy = '';
    }
  }

  /**
   * Include a row, asking first when the identity is unverified.
   *
   * The backend refuses an unacknowledged unverified include with a 409 and
   * that is the real guard - this only decides whether to ask before spending
   * the round trip. A UI that forgot to ask would still be safe.
   */
  function includeRow(r: { anilistId: number | null; title: string | null; unverified: boolean; grade?: string; matchedTitle?: string | null; gradeNote?: string | null }) {
    if (!r.anilistId) return;
    if (r.unverified) {
      confirming = {
        anilistId: r.anilistId,
        title: r.title ?? '(untitled)',
        grade: r.grade ?? 'weak',
        matchedTitle: r.matchedTitle ?? null,
        note: r.gradeNote ?? null,
      };
      return;
    }
    void post('/api/sonarr/include', { anilistId: r.anilistId });
  }

  async function confirmInclude() {
    if (!confirming) return;
    const id = confirming.anilistId;
    confirming = null;
    await post('/api/sonarr/include', { anilistId: id, acknowledgeUnverified: true });
  }

  function episodesOf(p: Proposed): number {
    return typeof p.episodes === 'number' && p.episodes > 0 ? p.episodes : ASSUMED_EPISODES;
  }

  $: incoming = (report?.proposed ?? []).filter((p) => p.state === 'willBeAdded');
  $: incomingEpisodes = incoming.reduce((n, p) => n + episodesOf(p), 0);
  $: assumedCount = incoming.filter((p) => !(typeof p.episodes === 'number' && p.episodes > 0)).length;
  // -- Every entry, one shape ------------------------------------------------
  // Proposed and rejected rows carry the same fields (the server's `describe`)
  // plus one status, so the page treats them as one list and the status alone
  // decides where a row goes and what colour it is.
  type Row = (Proposed | Rejected) & {
    kind: 'proposed' | 'rejected';
    reason?: string;
    outlier?: boolean;
    offset?: number;
  };
  /** Which rows the tables show. Needs attention above is not filtered by it. */
  let chip: Chip = 'all';
  /** Narrow everything to the viewing admin's own list - what their Randomize shows. */
  let myListOnly = false;
  $: allRows = report
    ? ([
        ...report.proposed.map((p) => ({ ...p, kind: 'proposed' as const })),
        ...report.rejected.map((r) => ({ ...r, kind: 'rejected' as const })),
      ] as Row[])
    : [];
  $: scoped = myListOnly ? allRows.filter((r) => r.onMyList) : allRows;
  $: myListCount = allRows.filter((r) => r.onMyList).length;
  // What Hide Not English hides on Randomize, from the same verdicts: the red
  // rows on the admin's list plus the ones not out yet, which are not red here.
  $: myHidden = allRows.filter((r) => r.onMyList && r.watchable === false);
  // An unaired show whose file landed early and has no English is red, not
  // "not aired yet" - only the uncoloured ones count here.
  $: myHiddenUnaired = myHidden.filter((r) => r.unaired && r.status.level !== 'broken').length;
  $: attentionRows = scoped.filter((r) => isAttention(r)).sort((a, b) => byLevel(a, b) || (a.title ?? '').localeCompare(b.title ?? ''));
  $: unattached = report?.attention ?? [];
  $: chipCounts = {
    attention: scoped.filter((r) => isAttention(r)).length + (myListOnly ? 0 : unattached.length),
    broken: scoped.filter((r) => r.status.level === 'broken').length,
    check: scoped.filter((r) => r.status.level === 'check').length,
    waiting: scoped.filter((r) => r.status.level === 'waiting').length,
    ok: scoped.filter((r) => r.status.level === 'ok').length,
    all: scoped.length,
  } as Record<Chip, number>;
  $: shown = scoped.filter((r) => chipMatches(chip, r));
  /** Rule-skipped rows, every season - the "Not auto-added" section. */
  $: skippedTotal = scoped.filter((r) => !r.wanted).length;
  $: skippedRows = shown
    .filter((r) => !r.wanted)
    .sort((a, b) => (a.season ?? '').localeCompare(b.season ?? '') || byLevel(a, b) || (a.title ?? '').localeCompare(b.title ?? ''));
  /** Wanted rows still waiting on their air window, for the counts table. */
  $: waitingCount = allRows.filter((r) => r.wanted && r.reason === 'outsideAirWindow').length;

  /**
   * Proposals per state, for the summary row.
   *
   * Seeded with every key so a state with no rows renders `0` rather than
   * vanishing - a missing column reads as a bug, and a summary you cannot
   * add up is worse than none.
   */
  $: byState = (report?.proposed ?? []).reduce<Record<string, number>>(
    (acc, p) => {
      acc[p.state] = (acc[p.state] ?? 0) + 1;
      return acc;
    },
    {
      willBeAdded: 0,
      pushedAlready: 0,
      addedByUs: 0,
      heldAlready: 0,
      excludedInSonarr: 0,
      lookupFailed: 0,
      failed: 0,
      unknown: 0,
    }
  );

  /**
   * The push log, actionable rows first.
   *
   * `lookupFailed` and `failed` mean nothing was added and both retry, so they
   * are the only rows worth a decision - burying them under a hundred
   * successful adds is how a persistent bad id goes unnoticed for a season.
   */
  const ATTENTION = new Set(['lookupFailed', 'failed']);
  // A superseded failure is history, not a to-do: its show was re-matched or
  // added under another id, so nothing about the old id can be acted on.
  $: openFailures = (report?.pushes ?? []).filter((p) => ATTENTION.has(p.status) && !p.superseded);

  // -- Refresh Jellyfin (the library check) --------------------------------
  // Runs daily on the server's schedule; the button is for "I just changed
  // something". The result feeds the English column in the season tables.
  $: lib = report?.library ?? null;

  function ago(iso: string): string {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    return h < 48 ? `${h} h ago` : new Date(iso).toLocaleDateString();
  }

  $: pushesSorted = [
    ...openFailures,
    ...(report?.pushes ?? []).filter((p) => !ATTENTION.has(p.status) || p.superseded),
  ];

  /** Premiere as a day number, for sorting and distance maths. Null when undated. */
  function airDay(d: Dated): number | null {
    if (!d?.year) return null;
    return Math.floor(Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1) / 86_400_000);
  }

  /**
   * How far a premiere sits from the middle of its own season.
   *
   * Measured 2026-08-09 across WINTER/SPRING/SUMMER 2026: **116 of 119
   * proposals fall within 14 days of their season's median premiere**, so a
   * row outside that is genuinely unusual and worth marking - those are the
   * ones that get grabbed alone weeks early, or sit "waiting on the air
   * window" long after the rest of their season is in.
   *
   * **This 14 is NOT the air window.** `DEFAULT_WITHIN_DAYS` measures distance
   * from *today* and decides membership; this measures distance from the
   * *season's median* and only decorates. Same number, different quantities -
   * do not unify them.
   */
  const OUTLIER_DAYS = 14;

  function median(ns: number[]): number | null {
    if (!ns.length) return null;
    const s = [...ns].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /**
   * Every wanted show, one table per season: what will be added, what was, what
   * is waiting on its premiere and what is wrong - nothing in a collapsed
   * section. Worst first, then by premiere, so the problems are at the top and
   * the rest reads as a schedule. Air-date outliers are marked against the
   * season's median premiere.
   */
  $: groups = (report?.seasons ?? []).map((s) => {
    const inSeason = (r: Row) => r.season === s.season && r.year === s.year && r.wanted;
    const wanted = scoped.filter(inSeason);
    const mid = median(wanted.map((p) => airDay(p.startDate)).filter((n): n is number => n !== null));
    return {
      ...s,
      total: wanted.length,
      waiting: wanted.filter((r) => r.status.level === 'waiting').length,
      rows: shown
        .filter(inSeason)
        .map((p) => {
          const d = airDay(p.startDate);
          const off = d !== null && mid !== null ? d - mid : 0;
          return { ...p, offset: off, outlier: Math.abs(off) > OUTLIER_DAYS };
        })
        .sort((a, b) =>
          byLevel(a, b)
          || (airDay(a.startDate) ?? Infinity) - (airDay(b.startDate) ?? Infinity)
          || (a.title ?? '').localeCompare(b.title ?? '')),
    };
  });

  /** The /admin/matching season for a push's entry, when the report has it. */
  function matchingLinkFor(anilistId: number | null): string {
    const r = anilistId != null ? allRows.find((x) => x.anilistId === anilistId) : undefined;
    return r?.season && r.year ? `/admin/matching?season=${r.season}&year=${r.year}` : '/admin/matching';
  }

  onMount(load);
</script>

<!--
  Sizing and column layout, both learned the hard way:

  * **No `text-xs` on the wrapper.** Measured against /admin/matching: its body
    and series titles render at 16px and its controls at 14px. An earlier
    version put `text-xs` on this page's root and `table-xs` on every table,
    which rendered content at 12px - a third smaller than the sibling page, and
    the reason it read as a different app. Small sizes are for legends and
    footnotes only.
  * **Every row table shares one `<colgroup>` and `table-fixed`.** Auto layout
    sizes each table to its own content, so the season tables and the
    not-on-the-list tables drifted out of alignment and looked jarring stacked
    up the page. Fixed widths are the only thing that makes separate tables line
    up.
-->
<AdminShell current="sonarr">

  {#if loading && !report}
    <span class="loading loading-spinner" aria-label="Loading" />
  {:else if loadError}
    <div class="alert alert-error">
      <span>{loadError}</span>
      <button class="btn btn-sm btn-outline" on:click={load}>Retry</button>
    </div>
  {:else if report}
    {#if notice}
      <div class="alert alert-info py-2 text-sm"><span>{notice}</span></div>
    {/if}

    <div
      class="rounded-lg border px-4 py-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2"
      class:border-warning={!report.published}
      class:bg-warning={!report.published}
      class:bg-opacity-10={!report.published}
      class:border-base-300={report.published}
      class:bg-base-200={report.published}
    >
      <div>
        <div class="font-semibold">
          {report.published ? 'Adding to Sonarr' : 'Paused - nothing is added'}
        </div>
        <p class="text-sm opacity-70 mt-0.5">
          {#if report.published}
            Runs daily. Each series is added <b>once</b> - if you or Maintainerr delete it later, it
            stays deleted.
          {:else}
            Nothing is added while paused. Everything below still shows what <em>would</em> be.
          {/if}
        </p>
        {#if report.config.problems.length}
          <p class="text-sm text-warning mt-1">
            Setup needed before anything can be added: {report.config.problems.join(', ')}.
          </p>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <button
          class="btn btn-sm btn-outline"
          disabled={busy === 'push' || !report.published || report.config.problems.length > 0}
          title="Add the pending series now instead of waiting for the daily run"
          on:click={pushNow}
        >
          {busy === 'push' ? 'Adding...' : 'Add now'}
        </button>
        <button
          class="btn btn-sm"
          class:btn-primary={!report.published}
          class:btn-outline={report.published}
          disabled={busy === '/api/sonarr/enabled'}
          on:click={() => post('/api/sonarr/enabled', { enabled: !report?.published }, { method: 'PUT' })}
        >
          {report.published ? 'Pause' : 'Start adding'}
        </button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p class="text-sm opacity-70">
        {#if preview}
          Previewing <b>{report.seasons.map((s) => `${s.season} ${s.year}`).join(' and ')}</b>.
          <span class="text-warning">A what-if - Sonarr is still served the current season and
          the next.</span>
        {:else}
          Looking at
          <b>{report.seasons.map((s) => `${s.season} ${s.year}`).join(' and ')}</b>
          - the current season and the next. An entry joins
          <b>{report.withinDays} days before its own premiere</b>, not before the season, and
          drops off when its season rolls over.
        {/if}
      </p>
      <select class="select select-bordered select-sm ml-auto" bind:value={preview} on:change={load}>
        <option value="">Both served seasons</option>
        {#each previewOptions as o (o)}
          <option value={o}>{o}</option>
        {/each}
      </select>
    </div>

    <!-- A responsive GRID, not `flex flex-wrap`. The counts table is 575px even
         with wrapped headers, and the page caps at 3/4 viewport - so below
         ~1280px the two blocks cannot share a row no matter how short the text
         beside them is. Flex-wrap made that look accidental: the right-hand
         block dropped underneath still right-aligned, reading as an orphaned
         paragraph. Stacked deliberately and left-aligned, it reads as its own
         row; side by side above xl, it reads as a pair. -->
    <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3
                grid grid-cols-1 xl:grid-cols-[auto_auto] xl:justify-between
                items-start gap-x-8 gap-y-3">
      <div class="overflow-x-auto -my-1" data-sonarr-stats>
        <table class="table table-xs w-auto [&_td]:py-1 [&_th]:py-1">
          <thead>
            <!-- `whitespace-normal` + a narrow max-width so these wrap to two
                 short lines instead of forcing the table wider than its column.
                 Measured at 1024px: the eight nowrap headers made this table
                 779px inside a 725px container, which pushed the block beside it
                 onto its own row and read as an unrelated paragraph. Wrapping
                 the words beats abbreviating them - this page has already been
                 through a round of "what does that label mean". -->
            <tr class="text-[10px] uppercase tracking-wider opacity-40
                       [&_th]:whitespace-normal [&_th]:max-w-[4.5rem] [&_th]:leading-tight">
              <th class="font-normal text-right">candidates</th>
              <th class="font-normal text-right border-l border-base-300">still to add</th>
              <th class="font-normal text-right border-l border-base-300">we added</th>
              <th class="font-normal text-right border-l border-base-300">you already had</th>
              <th class="font-normal text-right border-l border-base-300">Sonarr excludes</th>
              <th class="font-normal text-right border-l border-base-300">add failed</th>
              <th class="font-normal text-right border-l border-base-300">waiting on air date</th>
              <th class="font-normal text-right border-l border-base-300">not auto-added</th>
            </tr>
          </thead>
          <tbody class="[&_td]:tabular-nums [&_td]:text-right [&_td]:text-base">
            <tr>
              <td class="font-semibold">{report.counts.proposed}</td>
              <td class="font-semibold border-l border-base-300">{byState.willBeAdded}</td>
              <td class="border-l border-base-300">{byState.pushedAlready + byState.addedByUs}</td>
              <td class="border-l border-base-300">{byState.heldAlready}</td>
              <td class="border-l border-base-300">{byState.excludedInSonarr}</td>
              <td class="border-l border-base-300">{byState.lookupFailed + byState.failed}</td>
              <td class="border-l border-base-300">{waitingCount}</td>
              <td class="border-l border-base-300">{skippedTotal}</td>
            </tr>
          </tbody>
        </table>
        <p class="text-[11px] opacity-40 mt-1">
          candidates = still to add + we added + you already had + Sonarr excludes + add failed
        </p>
      </div>

      <!-- Two lines, label and value on the SAME line, and the button's
           explanation as its tooltip rather than a stray paragraph underneath.
           The previous shape was four ragged lines that left a label
           ("Your whole Sonarr library, not this list:") with its number on the
           next row, and floated a help paragraph with nothing obviously
           attached to it - while making this block 141px against the 71px one
           beside it, which is where the dead space came from. -->
      <div class="text-sm opacity-70 xl:text-right xl:ml-auto">
        <!-- Kept SHORT on purpose. This block and the counts table share one
             flex row, so a long sentence here stops both fitting and drops this
             onto its own line below the numbers - which reads as an unrelated
             paragraph. The old wording ("Your whole Sonarr library (not this
             page): ... N tagged anime + saltychart") did exactly that. The
             label that made it long is now the tooltip. -->
        <div title="Your whole Sonarr library, not just what this page proposes">
          {#if !report.config.configured}
            Sonarr is not configured -
            <a class="link" href="/admin">set it up on Connection</a>
          {:else if !report.sonarr.observed}
            Never successfully read {report.config.url}
          {:else}
            <span class="opacity-60">Library:</span>
            {report.sonarr.held.toLocaleString()} series, {report.sonarr.excluded} excluded
          {/if}
        </div>
        {#if report.sonarr.observed && report.history.pushed}
          <!-- Only once we have added something: "0 of 0 tagged" is noise, and
               the number only means anything against series we added. -->
          <div
            class:text-warning={report.config.taggedOfOurs < report.history.pushed}
            title="Series we added that carry the tags Maintainerr scopes on. Anything less than all of them means its cleanup will miss some."
          >
            <span class="opacity-60">Tagged <code>{report.config.markerTag}</code>:</span>
            {report.config.taggedOfOurs} of our {report.history.pushed}
          </div>
        {/if}
        <div class="mt-1 flex items-center xl:justify-end gap-2">
          <span class="opacity-60">
            {#if report.snapshot}
              Last read {new Date(report.snapshot.at).toLocaleDateString()}
            {:else}
              Never read
            {/if}
          </span>
          <button
            class="btn btn-sm btn-outline normal-case"
            title="Re-reads Sonarr's library and exclusion list so this page knows what is already there, and so a series is never added twice."
            on:click={snapshotNow}
            disabled={busy === 'snapshot'}
          >
            {busy === 'snapshot' ? 'Reading...' : 'Re-read Sonarr'}
          </button>
          <button
            class="btn btn-sm btn-outline normal-case"
            data-lib-check
            title="Use after changing a series in Sonarr: finds episodes Sonarr replaced that Jellyfin has not picked up, asks Jellyfin to rescan just those series so Randomize plays the new file, and updates the English column. Also runs once a day on its own."
            on:click={checkLibraryNow}
            disabled={busy === 'library' || !!lib?.running}
          >
            {busy === 'library' || lib?.running ? 'Refreshing...' : 'Refresh Jellyfin'}
          </button>
        </div>
        <!-- One line: when Jellyfin was last checked against Sonarr, and what it
             fixed. Never "0 problems" for "never checked". -->
        <div class="mt-1 text-xs opacity-60" data-lib-status>
          {#if lib?.last}
            Jellyfin checked {ago(lib.last.at)}{#if lib.last.refresh?.requested.length}
              - refreshed {lib.last.refresh.requested.map((x) => x.title).join(', ')}{/if}{#if lib.last.refresh?.stillStale.length}
              <span class="text-error">- still out of date: {lib.last.refresh.stillStale.join(', ')}</span>{/if}{#if lib.last.refresh?.newSeries?.found.length}
              - new in Jellyfin: {lib.last.refresh.newSeries.found.join(', ')}{/if}{#if lib.last.refresh?.newSeries?.stillMissing.length}
              <span class={lib.last.refresh.settled ? 'text-error' : ''}>- {lib.last.refresh.settled ? 'still not in Jellyfin' : 'scanning Jellyfin for'}: {lib.last.refresh.newSeries.stillMissing.join(', ')}</span>{/if}
          {:else if lib?.lastError}
            <span class="text-warning">Jellyfin not checked yet: {lib.lastError}</span>
          {:else}
            Jellyfin not checked yet - runs daily, or press Refresh Jellyfin
          {/if}
        </div>

        <!-- What has already happened.
             "We added N" is now sayable because only a 201 from Sonarr writes a
             `pushed` row. The Custom List version of this line had to say
             "tracking since", because all it knew was when a snapshot first
             looked - on a pre-existing library that was one instant shared by
             every row, and calling it an add date would have misdescribed
             someone's whole library. `alreadyHeld` stays counted separately for
             exactly that reason. -->
        <div class="mt-1 text-xs opacity-50">
          {#if report.history.ours === 0 && report.history.alreadyHeld === 0}
            Nothing added yet.
          {:else}
            {#if report.history.ours}
              <b>{report.history.ours}</b> ours
              <span title="Counted from BOTH the marker tag in Sonarr and our own push record. Neither alone is complete: the record does not follow a new database, and a series since deleted carries no tag.">
                (tag or record)
              </span>
              {#if report.history.lastPushAt}
                <span title="When we last added a series to Sonarr.">
                  - last added {new Date(report.history.lastPushAt).toLocaleDateString()}
                </span>
              {/if}
            {:else}
              None added by us yet
            {/if}{#if report.history.alreadyHeld},
              <b>{report.history.alreadyHeld}</b> you already had
            {/if}{#if report.history.needsAttention},
              <span class="text-warning"><b>{report.history.needsAttention}</b> need attention</span>
            {/if}
          {/if}
        </div>
      </div>
    </div>

    <div>
      {#if !report.sonarr.observed}
        <span class="font-semibold">Cannot tell what would be added</span>
        <span class="text-sm opacity-60">- Sonarr has never been read successfully</span>
      {:else}
        <span class="font-semibold">{byState.willBeAdded} still to add</span>
        {#if byState.willBeAdded}
          <span class="text-sm opacity-60">
            roughly {(incomingEpisodes * GB_MEDIAN).toFixed(0)} GB
            <!-- Dated, because this is a comparison against Sonarr as it was at
                 the last read - not as it is this second. Without the date the
                 number reads as live and quietly goes stale. -->
            {#if report.snapshot}
              as of {new Date(report.snapshot.at).toLocaleDateString()}
            {/if}
          </span>
          <p class="text-[11px] opacity-40 mt-0.5">
            {incomingEpisodes} episodes x 0.38 GB, the median episode in <em>your</em> library
            (500-episode sample, measured 2026-08-04). Could reach
            {(incomingEpisodes * GB_P90).toFixed(0)} GB if every one lands at the p90 of 1.35 GB.
            {#if assumedCount}
              {assumedCount} have no episode count yet, assumed {ASSUMED_EPISODES} each.
            {/if}
            Assumes today's mixed-quality library - a 720p-only profile in Sonarr makes this an
            over-estimate.
          </p>
        {/if}
      {/if}
    </div>

    {#if report.orphans.length}
      <div class="alert alert-error py-2 flex-col items-start gap-1 text-sm">
        <b>{report.orphans.length} held for an entry that has since been re-identified</b>
        <p class="opacity-80">We only ever read from Sonarr, so these have to be deleted by hand.</p>
        <ul class="list-disc pl-5">
          {#each report.orphans as o (o.tvdbId)}
            <li>Delete <b>{o.title}</b> (tvdb <ExternalIdLink id={o.tvdbId} />) - its entry now resolves to <ExternalIdLink id={o.nowTvdbId} />.</li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Needs attention FIRST: every wanted show that is red or yellow, across
         both seasons, plus failures no row in these seasons accounts for. It
         used to be spread across a collapsed "Not on the list" group, the
         waiting accordions and the bottom of the history log. -->
    <div class="rounded-lg border px-4 py-3"
         class:border-error={attentionRows.length + unattached.length > 0}
         class:border-base-300={attentionRows.length + unattached.length === 0}
         data-attention>
      <h2 class="font-semibold">
        Needs attention
        <span class="font-normal text-sm opacity-60">({attentionRows.length + unattached.length}{myListOnly ? ' on your list' : ''})</span>
      </h2>
      {#if attentionRows.length + unattached.length === 0}
        <p class="text-sm text-success mt-1">Nothing needs attention{myListOnly ? ' on your list' : ''}.</p>
      {:else}
        <ul class="mt-1 divide-y divide-base-300">
          {#each attentionRows as r (r.kind + (r.anilistId ?? r.title))}
            <li class="py-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm" data-attention-row data-code={r.status.code}>
              <StatusBadge status={r.status} />
              <span class="font-medium">{r.title ?? '(untitled)'}</span>
              <span class="text-xs opacity-50">{r.season ?? ''} {r.year ?? ''}</span>
              <span class="basis-full sm:basis-auto sm:flex-1 text-xs opacity-80">
                {r.status.text}{#each r.status.also ?? [] as a (a.code)}<span class={LEVEL[a.level].text}>{' - also: '}{a.text}</span>{/each}
              </span>
              {#if MATCH_CODES.has(r.status.code) || (r.status.also ?? []).some((a) => MATCH_CODES.has(a.code))}
                <a class="link link-primary text-xs" href={`/admin/matching?season=${r.season}&year=${r.year}`}>Fix match</a>
              {/if}
            </li>
          {/each}
          {#if !myListOnly}
            {#each unattached as u (u.tvdbId)}
              <li class="py-1.5 flex flex-wrap items-baseline gap-x-2 text-sm" data-attention-row data-code={u.status}>
                <span class="badge badge-sm badge-error whitespace-nowrap" data-level="broken">{u.status === 'lookupFailed' ? 'Sonarr rejected' : 'add failed'}</span>
                <span class="font-medium">{u.title || `tvdb ${u.tvdbId}`}</span>
                <span class="text-xs opacity-50">not in these seasons</span>
                <span class="flex-1 text-xs opacity-80">{u.lastError ?? ''}</span>
                {#if u.status === 'lookupFailed'}<a class="link link-primary text-xs" href="/admin/matching">Fix match</a>{/if}
              </li>
            {/each}
          {/if}
        </ul>
      {/if}
    </div>

    <!-- One filter row for everything below. Counts are in the buttons, so how
         much a filter hides is visible before it is clicked. -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <StatusChips bind:value={chip} counts={chipCounts} />
      <label class="label cursor-pointer gap-2 py-0" title="Only shows on your own list for these seasons - the same set your Randomize page shows">
        <input type="checkbox" class="toggle toggle-sm" bind:checked={myListOnly} data-my-list />
        <span class="text-sm">On my list ({myListCount})</span>
      </label>
      {#if myListCount}
        <span class="text-xs opacity-70" data-randomize-hides={myHidden.length}
              title="The same verdicts Randomize reads: a red row is hidden there, and so is a show not out yet whose file is not in the library (it stays uncoloured here - nothing is wrong with it)">
          Hide Not English on Randomize hides {myHidden.length} of these:
          {myHidden.length - myHiddenUnaired} red, {myHiddenUnaired} not aired yet
        </span>
      {/if}
      <p class="text-[11px] opacity-50 basis-full">
        {#each LEVELS as lv (lv)}
          <span class="badge badge-xs {LEVEL[lv].badge} mr-1 align-middle" aria-hidden="true"></span><span class="mr-3">{LEVEL[lv].label} = {LEVEL[lv].legend}</span>
        {/each}
        {#if report.summary.libraryAsked > report.summary.libraryAnswered}
          <span class="text-warning">The library did not answer for {report.summary.libraryAsked - report.summary.libraryAnswered} shows - they are not marked missing.</span>
        {/if}
      </p>
    </div>

    {#each groups as g (g.season + g.year)}
      <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3" data-season-group>
        <h2 class="font-semibold">
          {g.season} {g.year}
          <span class="font-normal text-sm opacity-60">
            - {g.total} we want{#if g.waiting}, {g.waiting} not aired yet{/if}{#if g.rows.length !== g.total}, {g.rows.length} shown{/if}
          </span>
        </h2>
        {#if g.rows.length}
          <div class="overflow-x-auto mt-2">
            <table class="table table-fixed w-full">
              <colgroup>
                <col style="width:3.5rem" /><col /><col style="width:4.5rem" />
                <col style="width:5rem" /><col style="width:9.5rem" />
                <col style="width:3rem" /><col style="width:7rem" /><col style="width:8.5rem" />
                <col style="width:30%" /><col style="width:8.5rem" />
              </colgroup>
              <thead>
                <tr class="opacity-60 text-xs">
                  <th></th><th>Title</th><th>TVDB</th><th>Format</th>
                  <th>Premieres</th><th class="text-right">Eps</th><th title={ENGLISH_TIP}>English</th><th>Status</th><th>Why</th><th></th>
                </tr>
              </thead>
              <tbody>
                {#each g.rows as r (r.kind + (r.anilistId ?? r.title))}
                  <SonarrEntryRow row={r} busy={busy === '/api/sonarr/include'} on:include={(e) => includeRow(e.detail)} />
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="text-sm opacity-60 mt-1">
            {g.total ? 'Nothing here matches the filter.' : 'Nothing from this season is wanted yet.'}
          </p>
        {/if}
      </div>
    {/each}

    <!-- Shows a rule skips (sequels nobody listed, films, adult). Same columns
         and badges as above, always open, and never counted in Needs
         attention - colour still means the result, so a skipped show the
         library lacks is still red. Listing it or pressing Include moves it up. -->
    <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3" data-skipped>
      <h2 class="font-semibold">
        Not auto-added
        <span class="font-normal text-sm opacity-60">({skippedTotal}{skippedRows.length !== skippedTotal ? `, ${skippedRows.length} shown` : ''})</span>
      </h2>
      <p class="text-[11px] opacity-50 mb-1">
        A rule left these off - each says which. They never count as needing attention unless someone
        lists one or presses Include.
      </p>
      {#if skippedRows.length}
        <div class="overflow-x-auto">
          <table class="table table-fixed w-full">
            <colgroup>
              <col style="width:3.5rem" /><col /><col style="width:4.5rem" />
              <col style="width:5rem" /><col style="width:9.5rem" />
              <col style="width:3rem" /><col style="width:7rem" /><col style="width:8.5rem" />
              <col style="width:30%" /><col style="width:8.5rem" />
            </colgroup>
            <thead>
              <tr class="opacity-60 text-xs">
                <th></th><th>Title</th><th>TVDB</th><th>Format</th>
                <th>Premieres</th><th class="text-right">Eps</th><th title={ENGLISH_TIP}>English</th><th>Status</th><th>Why</th><th></th>
              </tr>
            </thead>
            <tbody>
              {#each skippedRows as r (r.kind + (r.anilistId ?? r.title))}
                <SonarrEntryRow row={r} busy={busy === '/api/sonarr/include'} on:include={(e) => includeRow(e.detail)} />
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="text-sm opacity-60">{skippedTotal ? 'Nothing here matches the filter.' : 'Nothing was skipped.'}</p>
      {/if}
    </div>

    {#if report.pushes.length}
      <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3">
        <details>
          <summary class="cursor-pointer">
            <h2 class="font-semibold inline">Everything we have tried ({report.pushes.length})</h2>
            {#if openFailures.length}
              <span class="badge badge-sm badge-error badge-outline ml-2">
                {openFailures.length} failed - also listed under Needs attention
              </span>
            {/if}
          </summary>
          <!-- The two failing statuses are listed first and coloured, because
               they are the only rows anyone can act on: both mean nothing was
               added, and both will be retried on the next run. A `bad TVDB id`
               row is a matching problem, hence the link across. -->
          <p class="text-[11px] opacity-40 mt-1 mb-2">
            A series is added once. `added` and `already had` are permanent - deleting the series in
            Sonarr later does not bring it back here.
          </p>
          <ul class="text-sm">
            {#each pushesSorted as p (p.tvdbId)}
              <li class="flex items-center gap-2 py-0.5">
                {#if p.superseded}
                  <span class="badge badge-sm badge-outline whitespace-nowrap opacity-60"
                        title="This attempt failed, but the show has since been re-matched or added under another id - nothing to do">replaced</span>
                {:else}
                  <span
                    class="badge badge-sm whitespace-nowrap {STATE[p.status === 'pushed' ? 'pushedAlready' : p.status]?.cls ?? 'badge-outline'}"
                  >{STATE[p.status === 'pushed' ? 'pushedAlready' : p.status]?.label ?? p.status}</span>
                {/if}
                <span class="flex-1 truncate" title={p.title}>
                  {#if p.title}{p.title}{:else}tvdb <ExternalIdLink id={p.tvdbId} />{/if}
                </span>
                {#if p.lastError && !p.superseded && (p.status === 'lookupFailed' || p.status === 'failed')}
                  <span class="opacity-50 text-xs truncate max-w-[18rem]" title={p.lastError}>
                    {p.lastError}
                  </span>
                {/if}
                <span class="opacity-50 text-xs whitespace-nowrap">
                  {p.pushedAt
                    ? new Date(p.pushedAt).toLocaleDateString()
                    : p.lastAttemptAt
                      ? new Date(p.lastAttemptAt).toLocaleDateString()
                      : ''}
                </span>
                {#if p.status === 'lookupFailed' && !p.superseded}
                  <a class="link text-xs whitespace-nowrap" href={matchingLinkFor(p.anilistId)}>Fix the match</a>
                {/if}
              </li>
            {/each}
          </ul>
        </details>
      </div>
    {/if}
  {/if}

  <!-- Asking before an override, and saying exactly what is uncertain. A
       generic "are you sure" would be noise; naming what the id matched
       against is the thing that lets someone judge it. -->
  {#if confirming}
    <div class="modal modal-open">
      <div class="modal-box">
        <h3 class="font-bold">Include an unverified match?</h3>
        <p class="py-2 text-sm">
          <b>{confirming.title}</b> has an identity we could not verify
          ({GRADE[confirming.grade]?.label ?? confirming.grade}).
          {#if confirming.matchedTitle}
            It matched against <b>{confirming.matchedTitle}</b>.
          {/if}
          {#if confirming.note}
            <span class="opacity-60">({confirming.note})</span>
          {/if}
        </p>
        <p class="text-sm opacity-70">
          If that is the wrong series, Sonarr will download a whole season of it. Resolving it on
          <a class="link" href="/admin/matching">Matching</a> first is the safer route.
        </p>
        <div class="modal-action">
          <button class="btn btn-sm" on:click={() => (confirming = null)}>Cancel</button>
          <button class="btn btn-sm btn-warning" on:click={confirmInclude}>Include anyway</button>
        </div>
      </div>
    </div>
  {/if}
</AdminShell>
