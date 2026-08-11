<script lang="ts">
  import { onMount } from 'svelte';
  import { authToken } from '../stores/auth';
  import { apiJson, QUICK, ApiError } from '../lib/remote';
  import AdminShell from '../components/AdminShell.svelte';

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
   * to be grabbed. They meet at exactly one point: an entry excluded because it
   * has no usable TVDB id is a *matching* problem, so those rows link across.
   *
   * **The size estimate is a median, not a promise.** 0.38 GB/episode measured
   * 2026-08-04 over a random 500-episode sample of the live library; the
   * distribution has a long tail, hence the p90 alongside it.
   */

  const GB_MEDIAN = 0.38;
  const GB_P90 = 1.35;
  /** AniList leaves `episodes` null on plenty of unaired entries. Labelled, never hidden. */
  const ASSUMED_EPISODES = 12;

  const REASON_LABEL: Record<string, string> = {
    malformed: 'malformed cache row',
    format: 'not TV / TV Short',
    adult: 'adult',
    notFirstSeason: 'has a prequel/parent (not a first season)',
    outsideAirWindow: 'outside the air window',
    noAnilistId: 'no usable AniList id',
    noUsableTvdbId: 'no usable TVDB id',
    duplicateTvdbId: 'duplicate TVDB id',
    noTitle: 'no usable title',
  };

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
    status: string | null;
    startDate: Dated;
    season: string | null;
    year: number | null;
    cover: string | null;
    episodes: number | null;
    state: string;
    grade: string;
    unverified: boolean;
    matchedTitle: string | null;
    gradeNote: string | null;
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
    counts: { proposed: number; rejected: Record<string, number> };
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
        timeoutMs: QUICK,
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
  function includeRow(r: { anilistId: number | null; title: string | null; unverified: boolean; grade: string; matchedTitle: string | null; gradeNote: string | null }) {
    if (!r.anilistId) return;
    if (r.unverified) {
      confirming = {
        anilistId: r.anilistId,
        title: r.title ?? '(untitled)',
        grade: r.grade,
        matchedTitle: r.matchedTitle,
        note: r.gradeNote,
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

  function airDate(d: Proposed['startDate']): string {
    if (!d?.year) return 'no date';
    const m = String(d.month ?? 1).padStart(2, '0');
    const day = String(d.day ?? 1).padStart(2, '0');
    return `${d.year}-${m}-${day}`;
  }

  $: incoming = (report?.proposed ?? []).filter((p) => p.state === 'willBeAdded');
  $: incomingEpisodes = incoming.reduce((n, p) => n + episodesOf(p), 0);
  $: assumedCount = incoming.filter((p) => !(typeof p.episodes === 'number' && p.episodes > 0)).length;
  $: rejectedByReason = (report?.rejected ?? []).reduce<Record<string, Rejected[]>>((acc, r) => {
    (acc[r.reason] ||= []).push(r);
    return acc;
  }, {});
  /** The season a `noUsableTvdbId` row belongs to, for the /admin/matching link. */
  $: linkSeason = report?.seasons?.[0];

  /**
   * How many the "Not on the list" panel actually shows.
   *
   * Not `rejected.length`: the air-window entries are listed under their own
   * season with a join date, and counting them here as well would have the
   * heading disagree with the rows beneath it.
   */
  $: notOnListCount = (report?.rejected ?? []).filter((r) => r.reason !== 'outsideAirWindow').length;
  /** Held back purely on timing - they are listed under their own season. */
  $: waitingCount = (report?.rejected ?? []).filter((r) => r.reason === 'outsideAirWindow').length;

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
  $: needsAttention = (report?.pushes ?? []).filter((p) => ATTENTION.has(p.status));
  $: pushesSorted = [
    ...needsAttention,
    ...(report?.pushes ?? []).filter((p) => !ATTENTION.has(p.status)),
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

  /** Proposals grouped by season, alphabetical inside, with air-date outliers marked. */
  $: groups = (report?.seasons ?? []).map((s) => {
    const rows = (report?.proposed ?? []).filter((p) => p.season === s.season && p.year === s.year);
    const mid = median(rows.map((p) => airDay(p.startDate)).filter((n): n is number => n !== null));
    // Entries of this season that a gate held back purely on timing, plus when
    // the earliest of them joins - which is what turns "38 outside the air
    // window" from an alarming number into a schedule.
    const waiting = (report?.rejected ?? []).filter(
      (r) => r.reason === 'outsideAirWindow' && r.season === s.season && r.year === s.year
    );
    const soonest = waiting
      .map((r) => airDay(r.startDate))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b)[0];
    // Each waiting entry with the date it actually joins - 14 days before its
    // OWN premiere, not before the season. Most anime premiere on the season
    // boundary so they cluster, but the stragglers are weeks behind and the
    // schedule is the only thing that shows it.
    const waitingRows = waiting
      .map((r) => {
        const d = airDay(r.startDate);
        return { ...r, joins: d === null ? null : new Date((d - (report?.withinDays ?? 14)) * 86_400_000) };
      })
      .sort((a, b) => (a.joins?.getTime() ?? Infinity) - (b.joins?.getTime() ?? Infinity));
    return {
      ...s,
      rows: rows
        .map((p) => {
          const d = airDay(p.startDate);
          const off = d !== null && mid !== null ? d - mid : 0;
          return { ...p, offset: off, outlier: Math.abs(off) > OUTLIER_DAYS };
        })
        .sort((a, b) => a.title.localeCompare(b.title)),
      waiting: waiting.length,
      waitingRows,
      joinsAt:
        soonest === undefined
          ? null
          : new Date((soonest - (report?.withinDays ?? 14)) * 86_400_000),
    };
  });

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
              <th class="font-normal text-right border-l border-base-300">needs attention</th>
              <th class="font-normal text-right border-l border-base-300">waiting on air date</th>
              <th class="font-normal text-right border-l border-base-300">filtered out</th>
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
              <td class="border-l border-base-300">{notOnListCount}</td>
            </tr>
          </tbody>
        </table>
        <p class="text-[11px] opacity-40 mt-1">
          candidates = still to add + we added + you already had + Sonarr excludes + needs attention
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
            <li>Delete <b>{o.title}</b> (tvdb {o.tvdbId}) - its entry now resolves to {o.nowTvdbId}.</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#each groups as g (g.season + g.year)}
      <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3">
        <h2 class="font-semibold">
          {g.season} {g.year}
          <span class="font-normal text-sm opacity-60">
            - {g.rows.length} on the list{#if g.waiting}, {g.waiting} waiting for their air date{/if}
          </span>
        </h2>

        {#if g.rows.length}
          <div class="overflow-x-auto mt-2">
            <table class="table table-fixed w-full">
              <colgroup>
                <col style="width:3.5rem" /><col /><col style="width:4.5rem" />
                <col style="width:5rem" /><col style="width:6.5rem" />
                <col style="width:3rem" /><col style="width:7rem" />
                <col style="width:9rem" /><col style="width:6rem" />
              </colgroup>
              <thead>
                <tr class="opacity-60 text-xs">
                  <th></th><th>Title</th><th>TVDB</th><th>Format</th>
                  <th>Premieres</th><th class="text-right">Eps</th><th>Match</th><th>What happens</th><th></th>
                </tr>
              </thead>
              <tbody>
                {#each g.rows as p (p.tvdbId)}
                  <tr>
                    <td class="px-1">
                      {#if p.cover}
                        <img src={p.cover} alt="" class="h-11 w-auto rounded" loading="lazy" />
                      {/if}
                    </td>
                    <td class="truncate" title={p.title}>{p.title}</td>
                    <td class="opacity-60">{p.tvdbId}</td>
                    <td class="opacity-60">{p.format ?? '-'}</td>
                    <td class="opacity-60 whitespace-nowrap">
                      {airDate(p.startDate)}
                      {#if p.outlier}
                        <span
                          class="badge badge-xs badge-warning badge-outline ml-1"
                          title={`Premieres ${Math.abs(p.offset)} days ${p.offset < 0 ? 'before' : 'after'} the rest of ${g.season} ${g.year}`}
                        >{p.offset > 0 ? '+' : ''}{p.offset}d</span>
                      {/if}
                    </td>
                    <td class="opacity-60 text-right">{p.episodes ?? '?'}</td>
                    <td>
                      <span
                        class="badge badge-sm whitespace-nowrap {GRADE[p.grade]?.cls ?? 'badge-outline'}"
                        title={[p.matchedTitle && 'matched: ' + p.matchedTitle, p.gradeNote].filter(Boolean).join(' - ')}
                      >{GRADE[p.grade]?.label ?? p.grade}</span>
                    </td>
                    <td>
                      <span class="badge badge-sm whitespace-nowrap {STATE[p.state]?.cls ?? 'badge-outline'}">
                        {STATE[p.state]?.label ?? p.state}
                      </span>
                    </td>
                    <td></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}

        <!-- The waiting entries belong HERE, under their own season, not buried
             in a collapsed accordion at the bottom of the page. The heading
             counts them; asking "where did they go" and having to hunt is the
             failure this whole page exists to avoid. -->
        {#if g.waitingRows.length}
          <details class="mt-2">
            <summary class="cursor-pointer text-sm opacity-70 py-1">
              {g.waitingRows.length} waiting for their air date - each joins the list
              {report.withinDays} days before its own premiere{#if g.joinsAt}, the first on
              {g.joinsAt.toLocaleDateString(undefined, { timeZone: 'UTC' })}{/if}
            </summary>
            <div class="overflow-x-auto mt-1">
              <table class="table table-fixed w-full">
                <colgroup>
                  <col style="width:3.5rem" /><col /><col style="width:4.5rem" />
                  <col style="width:5rem" /><col style="width:6.5rem" />
                  <col style="width:3rem" /><col style="width:7rem" />
                  <col style="width:9rem" /><col style="width:6rem" />
                </colgroup>
                <thead>
                  <tr class="opacity-60 text-xs">
                    <th></th><th>Title</th><th>TVDB</th><th>Format</th>
                    <th>Premieres</th><th class="text-right">Eps</th><th>Match</th><th>Joins the list</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {#each g.waitingRows as r (r.anilistId ?? r.title)}
                    <tr>
                      <td class="px-1">
                        {#if r.cover}
                          <img src={r.cover} alt="" class="h-11 w-auto rounded" loading="lazy" />
                        {/if}
                      </td>
                      <td class="truncate" title={r.title ?? ''}>{r.title ?? '(untitled)'}</td>
                      <td class="opacity-60">{r.tvdbId ?? ''}</td>
                      <td class="opacity-60">{r.format ?? '-'}</td>
                      <td class="opacity-60 whitespace-nowrap">{airDate(r.startDate)}</td>
                      <td class="opacity-60 text-right">{r.episodes ?? '?'}</td>
                      <td>
                        <span class="badge badge-sm whitespace-nowrap {GRADE[r.grade]?.cls ?? 'badge-outline'}"
                        >{GRADE[r.grade]?.label ?? r.grade}</span>
                      </td>
                      <td class="opacity-70 whitespace-nowrap">
                        {r.joins ? r.joins.toLocaleDateString(undefined, { timeZone: 'UTC' }) : '-'}
                      </td>
                      <td></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </details>
        {:else if !g.rows.length}
          <p class="text-sm opacity-60 mt-1">Nothing from this season is on the list.</p>
        {/if}
      </div>
    {/each}

    <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3">
      <h2 class="font-semibold">Not on the list ({notOnListCount})</h2>
      <p class="text-[11px] opacity-40 mb-2">
        Entries in these seasons that a filter held back. None of these is an error - each names
        the rule that skipped it, and Include anyway overrides any of them.
      </p>
      <!-- `outsideAirWindow` is deliberately absent here: those entries are
           listed under their own season above, with the date each one joins.
           Showing them in both places was real duplication and made the page
           look like it was reporting the same thing twice. -->
      {#each Object.entries(rejectedByReason).filter(([reason]) => reason !== 'outsideAirWindow').sort((a, b) => b[1].length - a[1].length) as [reason, rows] (reason)}
        <details class="border-b border-base-300 last:border-0">
          <summary class="cursor-pointer py-1.5 flex items-center gap-2 text-sm">
            <span class="font-mono opacity-60 w-8 text-right">{rows.length}</span>
            <span>{REASON_LABEL[reason] ?? reason}</span>
            {#if reason === 'noUsableTvdbId' && linkSeason}
              <a
                class="link link-primary text-xs"
                href={`/admin/matching?season=${linkSeason.season}&year=${linkSeason.year}`}
              >resolve on Matching</a>
            {/if}
          </summary>
          <div class="overflow-x-auto pb-2">
            <table class="table table-fixed w-full">
              <colgroup>
                <col style="width:3.5rem" /><col /><col style="width:4.5rem" />
                <col style="width:5rem" /><col style="width:6.5rem" />
                <col style="width:3rem" /><col style="width:7rem" />
                <col style="width:9rem" /><col style="width:6rem" />
              </colgroup>
              <thead>
                <tr class="opacity-60 text-xs">
                  <th></th><th>Title</th><th>TVDB</th><th>Format</th>
                  <th>Premieres</th><th class="text-right">Eps</th><th>Match</th><th>Previous</th><th></th>
                </tr>
              </thead>
              <tbody>
                {#each rows as r (r.anilistId ?? r.title)}
                  <tr>
                    <td class="px-1">
                      {#if r.cover}
                        <img src={r.cover} alt="" class="h-11 w-auto rounded" loading="lazy" />
                      {/if}
                    </td>
                    <td class="truncate" title={r.title ?? ''}>{r.title ?? '(untitled)'}</td>
                    <td class="opacity-60">{r.tvdbId ?? ''}</td>
                    <td class="opacity-60">{r.format ?? '-'}</td>
                    <td class="opacity-60 whitespace-nowrap">{airDate(r.startDate)}</td>
                    <td class="opacity-60 text-right">{r.episodes ?? '?'}</td>
                    <!-- Match and action in SEPARATE columns, so the button
                         starts at the same x on every row instead of being
                         pushed around by whatever badge precedes it. -->
                    <td class="whitespace-nowrap">
                      <span
                        class="badge badge-sm whitespace-nowrap {GRADE[r.grade]?.cls ?? 'badge-outline'}"
                        title={[r.matchedTitle && 'matched: ' + r.matchedTitle, r.gradeNote].filter(Boolean).join(' - ')}
                      >{GRADE[r.grade]?.label ?? r.grade}</span>
                    </td>
                    <td class="whitespace-nowrap">
                      {#if r.parent}
                        <span
                          class="badge badge-sm whitespace-nowrap"
                          class:badge-success={r.parent.held}
                          class:badge-outline={!r.parent.held}
                          title={r.parent.title ?? ''}
                        >{r.parent.held ? 'have prev' : 'no prev'}</span>
                      {/if}
                    </td>
                    <td>
                      {#if r.anilistId}
                        <!-- An unverified identity gets a different label AND a
                             confirm. The backend 409s regardless - this is so
                             the click is informed, not so it is possible. -->
                        <button
                          class="btn btn-xs normal-case"
                          class:btn-primary={!r.unverified}
                          class:btn-warning={r.unverified}
                          disabled={busy === '/api/sonarr/include'}
                          on:click={() => includeRow(r)}
                        >{r.unverified ? 'Include anyway' : 'Include'}</button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </details>
      {/each}
    </div>

    {#if report.pushes.length}
      <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3">
        <details>
          <summary class="cursor-pointer">
            <h2 class="font-semibold inline">Everything we have tried ({report.pushes.length})</h2>
            {#if needsAttention.length}
              <span class="badge badge-sm badge-error badge-outline ml-2">
                {needsAttention.length} need attention
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
                <span
                  class="badge badge-sm whitespace-nowrap {STATE[p.status === 'pushed' ? 'pushedAlready' : p.status]?.cls ?? 'badge-outline'}"
                >{STATE[p.status === 'pushed' ? 'pushedAlready' : p.status]?.label ?? p.status}</span>
                <span class="flex-1 truncate" title={p.title}>{p.title || `tvdb ${p.tvdbId}`}</span>
                {#if p.lastError && (p.status === 'lookupFailed' || p.status === 'failed')}
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
                {#if p.status === 'lookupFailed'}
                  <a class="link text-xs whitespace-nowrap" href="/admin/matching">Fix the match</a>
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
