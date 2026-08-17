<script lang="ts">
  import { onMount } from 'svelte';
  import { authToken } from '../stores/auth';
  import { apiJson, apiFetch, QUICK, ApiError } from '../lib/remote';
  import AdminShell from '../components/AdminShell.svelte';

  /**
   * What the trailer subtitle pipeline has actually done.
   *
   * This page exists because the pipeline is otherwise unobservable: two
   * scheduled jobs write to it - a Wednesday medium batch on the server and a
   * Sunday large-v3-split GPU run on someone's PC - and the only way to see what
   * either did was to query SQLite by hand.
   *
   * A **third** question, distinct from the other admin tabs: not identity
   * (`/admin/matching`), not scope (`/admin/sonarr`), but production. Its data is
   * keyed by YouTube video id, not by series.
   *
   * **One table, not one per season.** Grouping by season and sorting by column
   * fight each other - a sort that restarts every few rows is not a sort. The
   * season is a column and a filter instead, and the per-season comparison lives
   * in its own summary block above.
   *
   * **Two things this page must never claim.** The Sunday run is a Windows
   * Scheduled Task and the server has no record it fired, so the champion line
   * says *last upload seen*, never *last run*. And an uncached season says so
   * rather than rendering zeroes - "couldn't ask" is not "nothing to do".
   *
   * Scope: trailers only. Jellyfin episode subtitles are a different subsystem
   * with no cache table and are deliberately not reported here.
   */

  type State = 'never' | 'checkedNoSubs' | 'translated' | 'youtubeCc' | 'burnedIn' | 'ourSubsOff';

  /**
   * Every state gets a visible badge, including the settled ones - the lesson
   * from `/admin/sonarr`, where badging only the interesting rows left a table
   * that read as mostly rendering failures. The two warning-coloured ones are
   * the two a human can act on.
   */
  const STATE: Record<State, { label: string; cls: string; help: string }> = {
    never: {
      label: 'never checked',
      cls: 'badge-warning',
      help: 'Nothing has looked at this trailer - no caption check, no translation.',
    },
    checkedNoSubs: {
      label: 'no subs yet',
      cls: 'badge-warning badge-outline',
      help: 'Checked for YouTube captions, found none, and nothing translated yet. This is the real backlog.',
    },
    translated: {
      label: 'translated',
      cls: 'badge-success',
      help: 'We have cached Whisper subtitles for this trailer.',
    },
    youtubeCc: {
      label: 'YouTube CC',
      cls: 'badge-outline opacity-70',
      help: 'YouTube already has English captions, so we never translate this one. Not a gap.',
    },
    burnedIn: {
      label: 'burned in',
      cls: 'badge-outline opacity-70',
      help: 'Subtitles are baked into the video image, so our overlay defaults off.',
    },
    ourSubsOff: {
      label: 'our subs off',
      cls: 'badge-ghost opacity-60',
      help: 'Someone turned our subtitles off for this trailer - for every viewer.',
    },
  };

  const STATE_ORDER: State[] = [
    'never',
    'checkedNoSubs',
    'translated',
    'youtubeCc',
    'burnedIn',
    'ourSubsOff',
  ];

  /** Actionable first - the order the backend sorts by, mirrored for sorting here. */
  const STATE_RANK: Record<State, number> = {
    never: 0,
    checkedNoSubs: 1,
    translated: 2,
    youtubeCc: 3,
    burnedIn: 4,
    ourSubsOff: 5,
  };

  type Row = {
    mediaId: number;
    title: string;
    cover: string | null;
    videoId: string;
    season: string;
    year: number;
    format: string | null;
    isAdult: boolean;
    state: State;
    modelName: string | null;
    belowChampion: boolean;
    segmentCount: number | null;
    hasEnglishSubs: boolean | null;
    lastEnCheckAt: string | null;
    hasBurnedInSubs: boolean;
    subtitlesDisabled: boolean;
    createdAt: string | null;
  };

  type SeasonSummary = {
    season: string;
    year: number;
    cached: boolean;
    entries: number;
    withTrailer: number;
    counts: Record<State, number>;
    belowChampion: number;
  };

  type Report = {
    overall: {
      tracked: number;
      translated: number;
      youtubeCc: number;
      burnedIn: number;
      ourSubsOff: number;
      belowChampion: number;
      byModel: Record<string, number>;
      newestAt: string | null;
    };
    schedule: {
      wednesday: {
        dayOfWeek: number;
        hourStart: number;
        hourEnd: number;
        daysBeforeSeason: number;
        nextSeason: string;
        nextSeasonYear: number;
        daysUntilNextSeason: number;
        nextWindowAt: string;
        inWindowNow: boolean;
        wouldFireAtNextWindow: boolean;
      };
      live: { running: boolean; season: string | null; year: number | null; startedAt: string | null; tail: string[] };
      lastRun: {
        startedAt: string | null;
        finishedAt: string;
        exitCode: number | null;
        season: string | null;
        year: number | null;
        tail: string[];
      } | null;
      champion: string;
      lastChampionUploadAt: string | null;
    };
    seasons: SeasonSummary[];
    rows: Row[];
  };

  let report: Report | null = null;
  /** Non-empty renders instead of the page, so a failure is never a blank screen. */
  let loadError = '';
  let loading = true;
  let busy = '';
  let notice = '';
  let confirmingDelete: Row | null = null;

  $: auth = { Authorization: `Bearer ${$authToken}` };

  // -------------------------------------------------------------------------
  // Scope: which season(s) the table covers
  // -------------------------------------------------------------------------

  const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;
  const now = new Date();

  /**
   * `''` means "whatever the jobs actually work on" - this season and the next,
   * which is what the backend serves when it gets no override. Anything else is
   * a single season.
   */
  let scopeSeason = '';
  let scopeYear = now.getFullYear();

  /**
   * The year is genuinely meaningless under "this season + next" - the backend
   * derives both seasons from the calendar - so the input is disabled there
   * rather than accepting a value it would ignore.
   *
   * **It needs its border forced back.** DaisyUI's `input:disabled` paints
   * `border-color` the same colour as the fill, so a disabled input loses its
   * outline entirely and reads as a broken grey block rather than a switched-off
   * control. The `disabled:` utilities below keep the outline and dim it, which
   * is what "disabled" is supposed to look like.
   */
  $: yearDisabled = !scopeSeason;

  // -------------------------------------------------------------------------
  // Filters and sorting
  // -------------------------------------------------------------------------

  /** '' = everything; 'attention' = the two states a human can act on. */
  let filterState: '' | 'attention' | State = '';
  /** '' = every row; 'none' = not translated; 'below' = translated below our best. */
  let filterModel = '';

  type SortKey = 'default' | 'season' | 'title' | 'state' | 'model' | 'cc' | 'translated';
  let sortKey: SortKey = 'default';
  let sortAsc = true;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = true;
    }
  }

  /**
   * `active` and `asc` are passed in rather than read off the component state,
   * and that is load-bearing, not style. Svelte only re-evaluates a template
   * expression when a variable *named in that expression* changes; state read
   * inside the function body is invisible to the compiler. As `arrow(key)` the
   * indicator rendered once and then froze while the rows underneath it happily
   * re-sorted - caught in a browser, because the sort itself worked.
   */
  function ariaSort(key: SortKey, active: SortKey, asc: boolean): 'ascending' | 'descending' | 'none' {
    if (active !== key) return 'none';
    return asc ? 'ascending' : 'descending';
  }

  /**
   * Sort indicator, as an HTML entity so this file stays ASCII - the triangles
   * themselves are pictographs and are banned in source. Rendered with `{@html}`
   * at the call site, which is safe here: the only two possible values are the
   * literals below.
   */
  function arrow(key: SortKey, active: SortKey, asc: boolean): string {
    if (active !== key) return '';
    return asc ? '&#9652;' : '&#9662;';
  }

  const SEASON_INDEX: Record<string, number> = { WINTER: 0, SPRING: 1, SUMMER: 2, FALL: 3 };

  function ms(iso: string | null): number {
    if (!iso) return 0;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? 0 : t;
  }

  /**
   * Models present in the current report, best-first, so the filter offers only
   * what exists rather than a hardcoded ladder that could drift from the one the
   * backend ranks by.
   */
  $: modelsPresent = report
    ? Object.keys(report.overall.byModel).sort((a, b) => a.localeCompare(b))
    : [];

  $: visibleRows = (() => {
    if (!report) return [] as Row[];
    let rows = report.rows;

    if (filterState === 'attention') {
      rows = rows.filter((r) => r.state === 'never' || r.state === 'checkedNoSubs');
    } else if (filterState) {
      rows = rows.filter((r) => r.state === filterState);
    }

    if (filterModel === 'none') {
      rows = rows.filter((r) => r.segmentCount === null);
    } else if (filterModel === 'below') {
      // Not `state === 'translated' && ...`: a row badged YouTube CC can still
      // hold an old translation a better model would redo, and the counts above
      // include it. See `belowChampion` in lib/subtitleReport.ts.
      rows = rows.filter((r) => r.belowChampion);
    } else if (filterModel) {
      rows = rows.filter((r) => r.modelName === filterModel && r.segmentCount !== null);
    }

    if (sortKey === 'default') return rows;

    const dir = sortAsc ? 1 : -1;
    const cmp: Record<Exclude<SortKey, 'default'>, (a: Row, b: Row) => number> = {
      season: (a, b) => a.year - b.year || SEASON_INDEX[a.season] - SEASON_INDEX[b.season],
      title: (a, b) => a.title.localeCompare(b.title),
      state: (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state],
      // Not-translated rows sort after every model rather than jumbling in with
      // the empty string. Done explicitly rather than with a high sentinel
      // character - a non-ASCII sentinel is invisible next to a real one.
      model: (a, b) => {
        const am = a.modelName ?? '';
        const bm = b.modelName ?? '';
        if (!am && !bm) return 0;
        if (!am) return 1;
        if (!bm) return -1;
        return am.localeCompare(bm);
      },
      cc: (a, b) => Number(a.hasEnglishSubs ?? -1) - Number(b.hasEnglishSubs ?? -1),
      translated: (a, b) => ms(a.createdAt) - ms(b.createdAt),
    };
    // Copy before sorting: `report.rows` is the source of truth for the counts
    // above, and sorting in place would reorder it under them.
    return [...rows].sort((a, b) => cmp[sortKey as Exclude<SortKey, 'default'>](a, b) * dir || a.title.localeCompare(b.title));
  })();

  /** Percentage of the tracked total, for tiles whose raw count only ever grows. */
  function pct(n: number, of: number): string {
    if (!of) return '';
    return `${Math.round((n / of) * 100)}%`;
  }

  async function load() {
    if (!$authToken) return;
    loading = true;
    loadError = '';
    try {
      // Built here rather than in a `$:` statement: an `on:change` handler runs
      // before Svelte flushes reactive declarations, so a derived query string
      // would still be the previous season's. That exact bug produced
      // `?season=&year=NaN` and a 400 on /admin/sonarr.
      const qs = scopeSeason ? `?season=${scopeSeason}&year=${scopeYear}` : '';
      report = await apiJson<Report>(`/api/translate/report${qs}`, { headers: auth }, {
        timeoutMs: QUICK,
        label: 'subtitle-report',
      });
    } catch (e) {
      loadError =
        e instanceof ApiError && e.unreachable
          ? "Couldn't reach the backend."
          : 'Could not load the subtitle report.';
    } finally {
      loading = false;
    }
  }

  /**
   * Turn our subtitles on or off for a trailer.
   *
   * `PATCH /dismiss` is deliberately unauthenticated - it backs the CC toggle in
   * the player, which guests use - so this sends no token and adds no exposure
   * the player does not already have.
   */
  async function toggleSubs(row: Row) {
    busy = row.videoId;
    notice = '';
    try {
      await apiFetch(
        `/api/translate/dismiss?videoId=${row.videoId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: !row.subtitlesDisabled }),
        },
        { timeoutMs: QUICK, label: 'subtitle-dismiss' }
      );
      notice = row.subtitlesDisabled
        ? `Our subtitles are back on for ${row.title} - for everyone.`
        : `Our subtitles are off for ${row.title} - for everyone.`;
      await load();
    } catch {
      notice = 'That did not go through. Nothing was changed.';
    } finally {
      busy = '';
    }
  }

  async function deleteTranslation() {
    const row = confirmingDelete;
    if (!row) return;
    confirmingDelete = null;
    busy = row.videoId;
    notice = '';
    try {
      await apiJson(
        `/api/translate/cache?videoId=${row.videoId}`,
        { method: 'DELETE', headers: auth },
        { timeoutMs: QUICK, label: 'subtitle-cache-delete' }
      );
      notice = `Deleted the cached translation for ${row.title}. The next play re-translates on demand.`;
      await load();
    } catch {
      notice = 'That did not go through. Nothing was changed.';
    } finally {
      busy = '';
    }
  }

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function when(iso: string | null): string {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'unknown';
    return d.toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function ago(iso: string | null): string {
    if (!iso) return '';
    const delta = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(delta)) return '';
    const days = Math.floor(delta / 86_400_000);
    if (days < 1) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 60) return `${days} days ago`;
    return `${Math.floor(days / 30)} months ago`;
  }

  function hour12(h: number): string {
    return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  }

  onMount(load);
</script>

<AdminShell current="subtitles">
  {#if loading && !report}
    <p class="opacity-70">Loading the subtitle report...</p>
  {:else if loadError}
    <div class="alert alert-error">
      <span>{loadError}</span>
      <button class="btn btn-sm btn-outline" on:click={load}>Retry</button>
    </div>
  {:else if report}
    {#if notice}
      <div class="alert alert-info py-2">
        <span>{notice}</span>
        <button class="btn btn-xs btn-outline" on:click={() => (notice = '')}>Dismiss</button>
      </div>
    {/if}

    <!-- ============================ Overall =========================== -->
    <section>
      <h2 class="text-lg font-semibold mb-1">Overall</h2>
      <p class="text-sm opacity-70 mb-3">
        Every trailer the pipeline has ever written a row for -
        <strong>{report.overall.tracked}</strong> of them - across all seasons, not
        just the ones in the table below. That is a count of what we have
        <em>looked at</em>, not of every trailer that exists, so the percentages
        below are shares of those {report.overall.tracked}.
      </p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="stat bg-base-200 rounded-box p-3">
          <div class="stat-title text-xs">We translated</div>
          <div class="stat-value text-3xl text-success">{report.overall.translated}</div>
          <div class="stat-desc text-xs">{pct(report.overall.translated, report.overall.tracked)} of tracked</div>
        </div>
        <div class="stat bg-base-200 rounded-box p-3">
          <div class="stat-title text-xs">YouTube has captions</div>
          <div class="stat-value text-3xl">{report.overall.youtubeCc}</div>
          <div class="stat-desc text-xs">
            {pct(report.overall.youtubeCc, report.overall.tracked)} of tracked - we never translate these
          </div>
        </div>
        <div class="stat bg-base-200 rounded-box p-3">
          <div class="stat-title text-xs">Burned into the video</div>
          <div class="stat-value text-3xl">{report.overall.burnedIn}</div>
          <div class="stat-desc text-xs">{pct(report.overall.burnedIn, report.overall.tracked)} of tracked</div>
        </div>
        <div class="stat bg-base-200 rounded-box p-3">
          <div class="stat-title text-xs">Our subs turned off</div>
          <div class="stat-value text-3xl">{report.overall.ourSubsOff}</div>
          <div class="stat-desc text-xs">
            {pct(report.overall.ourSubsOff, report.overall.tracked)} of tracked - for every viewer
          </div>
        </div>
      </div>

      <!-- Quality sits inside Overall rather than floating on its own line: it
           describes the same {tracked} population, and as a stray caption nobody
           could tell whether it meant the whole cache or the season below. -->
      <div class="mt-3 bg-base-200 rounded-box p-3">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="font-medium">Quality of those {report.overall.translated} translations</span>
          {#if report.overall.belowChampion > 0}
            <span class="badge badge-warning">
              {report.overall.belowChampion} not on our best model
            </span>
          {:else}
            <span class="badge badge-success">all on our best model</span>
          {/if}
        </div>
        <p class="text-xs opacity-70 mt-1">
          Our best is <code>{report.schedule.champion}</code>. Anything translated by a
          weaker model still works - the Sunday GPU run simply redoes it at higher
          quality next time it reaches that trailer, so this number is a queue
          length, not a fault count.
        </p>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {#each Object.entries(report.overall.byModel).sort((a, b) => b[1] - a[1]) as [model, n]}
            <span
              class="badge"
              class:badge-success={model === report.schedule.champion}
              class:badge-outline={model !== report.schedule.champion}
              title={model === report.schedule.champion ? 'Our best pipeline' : 'Would be redone by the Sunday GPU run'}
            >
              {model}: {n}
            </span>
          {/each}
          {#if !Object.keys(report.overall.byModel).length}
            <span class="opacity-60">Nothing translated yet.</span>
          {/if}
        </div>
      </div>
    </section>

    <!-- ============================ Schedule ========================== -->
    <section>
      <h2 class="text-lg font-semibold mb-3">Schedule</h2>
      <div class="grid gap-3 lg:grid-cols-2">
        <div class="card bg-base-200">
          <div class="card-body p-4 gap-2">
            <h3 class="font-semibold">Server batch (medium model)</h3>
            <p class="text-sm opacity-80">
              Runs {DAYS[report.schedule.wednesday.dayOfWeek]}s between
              {hour12(report.schedule.wednesday.hourStart)} and
              {hour12(report.schedule.wednesday.hourEnd)}, but only when the next season
              is within {report.schedule.wednesday.daysBeforeSeason} days.
            </p>
            <p class="text-sm">
              Next window: <strong>{when(report.schedule.wednesday.nextWindowAt)}</strong>
              {#if report.schedule.wednesday.inWindowNow}
                <span class="badge badge-info badge-sm ml-1">window open now</span>
              {/if}
            </p>
            {#if report.schedule.wednesday.wouldFireAtNextWindow}
              <p class="text-sm text-success">
                It will run - {report.schedule.wednesday.nextSeason}
                {report.schedule.wednesday.nextSeasonYear} is
                {report.schedule.wednesday.daysUntilNextSeason} days away.
              </p>
            {:else}
              <p class="text-sm opacity-80">
                It will not run yet - {report.schedule.wednesday.nextSeason}
                {report.schedule.wednesday.nextSeasonYear} is
                {report.schedule.wednesday.daysUntilNextSeason} days away, past the
                {report.schedule.wednesday.daysBeforeSeason}-day threshold. The job is
                waiting on purpose, not broken.
              </p>
            {/if}

            {#if report.schedule.live.running}
              <div class="alert alert-info py-2 text-sm">
                <span>
                  Running now - {report.schedule.live.season}
                  {report.schedule.live.year || ''}, started {when(report.schedule.live.startedAt)}
                </span>
              </div>
              {#if report.schedule.live.tail.length}
                <pre class="text-xs bg-base-300 rounded p-2 overflow-x-auto max-h-40">{report.schedule.live.tail.join('\n')}</pre>
              {/if}
            {:else if report.schedule.lastRun}
              <p class="text-sm">
                Last run finished <strong>{when(report.schedule.lastRun.finishedAt)}</strong>
                ({ago(report.schedule.lastRun.finishedAt)})
                {#if report.schedule.lastRun.exitCode === 0}
                  <span class="badge badge-success badge-sm ml-1">clean exit</span>
                {:else}
                  <span class="badge badge-error badge-sm ml-1">
                    exit {report.schedule.lastRun.exitCode ?? 'unknown'}
                  </span>
                {/if}
              </p>
              {#if report.schedule.lastRun.tail.length}
                <details class="text-xs">
                  <summary class="cursor-pointer opacity-70">Last lines of that run</summary>
                  <pre class="bg-base-300 rounded p-2 mt-1 overflow-x-auto max-h-40">{report.schedule.lastRun.tail.join('\n')}</pre>
                </details>
              {/if}
            {:else}
              <p class="text-sm opacity-70">
                No completed run on record. Runs are recorded from now on, so this stays
                empty only until the next one finishes.
              </p>
            {/if}
          </div>
        </div>

        <div class="card bg-base-200">
          <div class="card-body p-4 gap-2">
            <h3 class="font-semibold">Local GPU run ({report.schedule.champion})</h3>
            <p class="text-sm opacity-80">
              A Windows Scheduled Task on the owner's PC, Sundays at 5am. It covers three
              seasons and uploads our best-quality output, which is why the server batch
              is only a fallback.
            </p>
            <p class="text-sm">
              Last upload seen:
              <strong>{when(report.schedule.lastChampionUploadAt)}</strong>
              {#if report.schedule.lastChampionUploadAt}
                <span class="opacity-70">({ago(report.schedule.lastChampionUploadAt)})</span>
              {/if}
            </p>
            <p class="text-xs opacity-60">
              This is the newest {report.schedule.champion} row in the cache, not a record
              that the task ran. The server cannot observe that job - a run that found
              nothing new to do leaves no trace here.
            </p>
          </div>
        </div>
      </div>

      <!-- The rules are stated, not re-implemented: the filter itself lives in
           backend/scripts/batch_translate.py (filter_eligible). Duplicating it in
           TypeScript would be a fourth copy of a rule that already lives in three
           files, which is how the modelName ladder went wrong. -->
      <details class="mt-3 text-sm">
        <summary class="cursor-pointer font-medium">What does the batch actually translate?</summary>
        <div class="mt-2 pl-4 opacity-80 space-y-1">
          <p>Four filters, all of which must pass (<code>batch_translate.py</code>, <code>filter_eligible</code>):</p>
          <ul class="list-disc pl-5 space-y-1">
            <li>Format is <code>TV</code>, <code>TV_SHORT</code>, <code>OVA</code>, <code>ONA</code> or <code>SPECIAL</code> - <strong>movies and music videos are excluded</strong></li>
            <li>Not 18+</li>
            <li>No <code>SEQUEL</code>, <code>PREQUEL</code>, <code>SIDE_STORY</code> or <code>SPINOFF</code> relation - note this also drops a genuine first season that later spawned a sequel</li>
            <li>Has a YouTube trailer</li>
          </ul>
          <p class="pt-1">
            <strong>On-demand translation ignores all of this.</strong> A viewer opening any
            trailer with no English captions gets one translated live, so the cache holds
            rows for movies and sequels the batch would never pick up.
          </p>
        </div>
      </details>
    </section>

    <!-- ====================== Per-season summary ====================== -->
    <section>
      <h2 class="text-lg font-semibold mb-1">By season</h2>
      <p class="text-sm opacity-70 mb-3">
        Shared columns so seasons read by comparison. Only entries with a YouTube
        trailer can be translated at all, which is why that column is usually lower
        than the entry count.
      </p>
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Season</th>
              <th class="text-right">Entries</th>
              <th class="text-right">With a trailer</th>
              {#each STATE_ORDER as s}
                <th class="text-right" title={STATE[s].help}>{STATE[s].label}</th>
              {/each}
              <th class="text-right" title="Translated by a weaker model; the Sunday GPU run would redo these">
                not best model
              </th>
            </tr>
          </thead>
          <tbody>
            {#each report.seasons as s}
              <tr>
                <td class="font-medium whitespace-nowrap">{s.season} {s.year}</td>
                {#if !s.cached}
                  <td colspan={STATE_ORDER.length + 3} class="opacity-70 italic">
                    This season isn't cached yet - nothing has been asked of AniList for it,
                    so there is nothing to report (which is not the same as nothing to do).
                  </td>
                {:else}
                  <td class="text-right">{s.entries}</td>
                  <td class="text-right">{s.withTrailer}</td>
                  {#each STATE_ORDER as st}
                    <td
                      class="text-right"
                      class:font-semibold={s.counts[st] > 0 && (st === 'never' || st === 'checkedNoSubs')}
                    >{s.counts[st]}</td>
                  {/each}
                  <td class="text-right">{s.belowChampion}</td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- ======================== Per-trailer table ===================== -->
    <section>
      <h2 class="text-lg font-semibold mb-2">Trailers</h2>

      <div class="flex flex-wrap items-end gap-2 mb-3">
        <label class="form-control">
          <span class="label-text text-xs">Season</span>
          <select class="select select-bordered select-sm" bind:value={scopeSeason} on:change={load}>
            <option value="">This season + next</option>
            {#each SEASONS as s}<option value={s}>{s}</option>{/each}
          </select>
        </label>
        <label class="form-control">
          <span class="label-text text-xs">Year</span>
          <input
            class="input input-bordered input-sm w-24 disabled:border-base-content/25 disabled:opacity-60"
            type="number"
            bind:value={scopeYear}
            on:change={load}
            disabled={yearDisabled}
            title={yearDisabled ? 'Pick a specific season to set the year' : 'Year to show'}
          />
        </label>
        <label class="form-control">
          <span class="label-text text-xs">State</span>
          <select class="select select-bordered select-sm" bind:value={filterState}>
            <option value="">All states</option>
            <option value="attention">Needs attention</option>
            {#each STATE_ORDER as s}<option value={s}>{STATE[s].label}</option>{/each}
          </select>
        </label>
        <label class="form-control">
          <span class="label-text text-xs">Translation</span>
          <select class="select select-bordered select-sm" bind:value={filterModel}>
            <option value="">Any</option>
            <option value="none">Not translated</option>
            <option value="below">Not on our best model</option>
            {#each modelsPresent as m}<option value={m}>{m}</option>{/each}
          </select>
        </label>
        <button class="btn btn-sm btn-outline" on:click={load} disabled={loading}>
          {#if loading}<span class="loading loading-spinner loading-xs"></span>{/if}
          Refresh
        </button>
        <span class="text-sm opacity-70 ml-auto">
          {visibleRows.length} of {report.rows.length} shown
        </span>
      </div>

      {#if report.rows.length === 0}
        <p class="text-sm opacity-70 italic">
          {report.seasons.some((s) => !s.cached)
            ? "That season isn't cached yet, so there is nothing to list."
            : 'No entries with a YouTube trailer in this scope.'}
        </p>
      {:else if visibleRows.length === 0}
        <p class="text-sm opacity-70 italic">No trailers match these filters.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <!-- `link` and not `link link-hover`: link-hover only underlines
                     on hover, which is the same "looks like plain text until you
                     touch it" problem as btn-ghost. A sortable header has to
                     advertise that it is clickable. -->
                <th aria-sort={ariaSort('season', sortKey, sortAsc)}>
                  <button class="link font-semibold" on:click={() => toggleSort('season')}>
                    Season {@html arrow('season', sortKey, sortAsc)}
                  </button>
                </th>
                <th aria-sort={ariaSort('title', sortKey, sortAsc)}>
                  <button class="link font-semibold" on:click={() => toggleSort('title')}>
                    Title {@html arrow('title', sortKey, sortAsc)}
                  </button>
                </th>
                <th aria-sort={ariaSort('state', sortKey, sortAsc)}>
                  <button class="link font-semibold" on:click={() => toggleSort('state')}>
                    State {@html arrow('state', sortKey, sortAsc)}
                  </button>
                </th>
                <th aria-sort={ariaSort('model', sortKey, sortAsc)}>
                  <button class="link font-semibold" on:click={() => toggleSort('model')}>
                    Model {@html arrow('model', sortKey, sortAsc)}
                  </button>
                </th>
                <th aria-sort={ariaSort('cc', sortKey, sortAsc)}>
                  <button class="link font-semibold" on:click={() => toggleSort('cc')}>
                    YouTube CC {@html arrow('cc', sortKey, sortAsc)}
                  </button>
                </th>
                <th aria-sort={ariaSort('translated', sortKey, sortAsc)}>
                  <button class="link font-semibold" on:click={() => toggleSort('translated')}>
                    Translated {@html arrow('translated', sortKey, sortAsc)}
                  </button>
                </th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <!-- Keyed by mediaId, NOT videoId: two AniList entries can share
                   one YouTube trailer (real case, SUMMER 2025), and a duplicate
                   key makes Svelte throw and mis-patch the rows. -->
              {#each visibleRows as r (r.mediaId)}
                <tr>
                  <td class="whitespace-nowrap text-xs opacity-70">{r.season} {r.year}</td>
                  <td>
                    <div class="flex items-center gap-2">
                      {#if r.cover}
                        <img src={r.cover} alt="" class="w-8 h-11 object-cover rounded" loading="lazy" />
                      {/if}
                      <div class="min-w-0">
                        <div class="truncate max-w-[22rem]">{r.title}</div>
                        <div class="text-xs opacity-60">
                          {r.format ?? 'unknown format'}
                          {#if r.isAdult}<span class="badge badge-xs badge-error ml-1">18+</span>{/if}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span class="badge {STATE[r.state].cls} whitespace-nowrap" title={STATE[r.state].help}>
                      {STATE[r.state].label}
                    </span>
                  </td>
                  <td class="whitespace-nowrap">
                    <!-- Shown whenever a translation exists, not only when the
                         badge says "translated": a YouTube CC row can also hold
                         one, and hiding it made the Model column disagree with
                         the Delete button next to it. -->
                    {#if r.modelName && r.segmentCount !== null}
                      <span
                        class="badge badge-sm"
                        class:badge-warning={r.belowChampion}
                        class:badge-outline={!r.belowChampion}
                        title={r.belowChampion ? 'The Sunday GPU run would redo this at higher quality' : 'Our best model'}
                      >
                        {r.modelName}
                      </span>
                      {#if r.segmentCount !== null}
                        <span class="text-xs opacity-60 ml-1">{r.segmentCount} lines</span>
                      {/if}
                    {:else}
                      <span class="opacity-40">-</span>
                    {/if}
                  </td>
                  <td class="whitespace-nowrap text-sm">
                    {#if r.hasEnglishSubs === true}
                      yes
                    {:else if r.hasEnglishSubs === false}
                      <span class="opacity-70">no</span>
                      {#if r.lastEnCheckAt}
                        <span class="text-xs opacity-50 block">checked {ago(r.lastEnCheckAt)}</span>
                      {/if}
                    {:else}
                      <span class="opacity-40">not checked</span>
                    {/if}
                  </td>
                  <td class="whitespace-nowrap text-sm opacity-70">
                    {r.segmentCount !== null ? ago(r.createdAt) : '-'}
                  </td>
                  <td class="text-right whitespace-nowrap">
                    <!-- btn-outline, not btn-ghost: DaisyUI renders ghost buttons
                         with a transparent background AND border until hover, so
                         at rest they are indistinguishable from plain text. -->
                    <button
                      class="btn btn-xs btn-outline"
                      disabled={busy === r.videoId}
                      on:click={() => toggleSubs(r)}
                    >
                      {r.subtitlesDisabled ? 'Turn our subs on' : 'Turn our subs off'}
                    </button>
                    {#if r.segmentCount !== null}
                      <button
                        class="btn btn-xs btn-outline btn-error"
                        disabled={busy === r.videoId}
                        on:click={() => (confirmingDelete = r)}
                      >
                        Delete translation
                      </button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</AdminShell>

<!-- The confirm names the real cost, not a generic "are you sure": deleting drops
     the cached translation back to whatever the on-demand daemon produces, which
     is `small` - a downgrade until a batch reaches it again. -->
{#if confirmingDelete}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg">Delete the cached translation?</h3>
      <p class="py-2">
        <strong>{confirmingDelete.title}</strong> is currently cached at
        <strong>{confirmingDelete.modelName ?? 'unknown'}</strong>
        ({confirmingDelete.segmentCount ?? 0} lines).
      </p>
      <p class="py-2 text-sm opacity-80">
        Deleting it means the next viewer re-translates on demand with the
        <strong>small</strong> model - a downgrade, until a batch run reaches this trailer
        again. Do this to clear a wrong or corrupt translation, not to force an upgrade.
      </p>
      <div class="modal-action">
        <button class="btn btn-outline" on:click={() => (confirmingDelete = null)}>Cancel</button>
        <button class="btn btn-error" on:click={deleteTranslation}>Delete it</button>
      </div>
    </div>
  </div>
{/if}
