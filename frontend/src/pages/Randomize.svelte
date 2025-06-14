<script lang="ts">
  import SeasonSelect from '../components/SeasonSelect.svelte';
  import { authToken } from '../stores/auth';
import { options } from '../stores/options';
// Reactive trigger for title-language changes
$: _lang = $options.titleLanguage;

  export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

  let season: Season = 'SPRING';
  let year: number = new Date().getFullYear();

  // User list for current season/year
  let watchList: any[] = [];
  let anime: any[] = [];

  // Wheel DOM reference & animation state
  let wheelEl: HTMLDivElement;
  let rotation = 0; // degrees
  let spinning = false;

  // Selected item after spin
  let selected: any = null;

  // ------------------------------------------------------------------
  // Guard: page only makes sense when the user is logged-in.  When the
  // token disappears (logout) we reset state *and* navigate away to the
  // home page so users don’t interact with a stale wheel.
  // ------------------------------------------------------------------

  $: if (!$authToken) {
    // Clear all derived lists and UI state
    watchList = [];
    anime = [];
    rotation = 0;
    selected = null;

    // If user somehow reached this page while logged-out, kick back home
    if (typeof window !== 'undefined' && window.location.pathname === '/random') {
      history.replaceState({}, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  // Fetch list from backend
  async function fetchList() {
    if (!$authToken) {
      watchList = [];
      return;
    }
    const res = await fetch(`/api/list?season=${season}&year=${year}`, {
      headers: { Authorization: `Bearer ${$authToken}` }
    });
    if (res.ok) watchList = await res.json();
  }

  async function fetchAnime() {
    const res = await fetch(`/api/anime?season=${season}&year=${year}`);
    if (res.ok) anime = await res.json();
  }


  const fetchBoth = async () => {
    await Promise.all([fetchList(), fetchAnime()]);
  };

  // Track last fetched year/season to avoid duplicate loads.
  let lastSeasonYearKey: string | null = null;

  // Initial & subsequent fetches.
  $: {
    const key = `${season}-${year}`;
    if (key !== lastSeasonYearKey) {
      lastSeasonYearKey = key;
      fetchBoth();
    }
  }

  // Separate entries into watched/unwatched for easier handling.
  //  * watchedEntries is needed for the ranking sidebar.
  //  * We no longer hide watched shows from the left sidebar – that list now
  //    shows *all* items but greys-out the ones already watched.

  $: watchedEntries = watchList.filter((w) => w.watched);
  $: unwatchedEntries = watchList.filter((w) => !w.watched);

  // Build wheel items with full anime data, but only for entries that have
  // NOT been watched yet so we never spin on already-watched shows.
  $: wheelItems = unwatchedEntries
    .map((w) => {
      const data = anime.find((a) => a.id === w.mediaId);
      return data ? { ...data, customName: w.customName ?? null } : null;
    })
    .filter(Boolean);

  // (Watched ranking is handled separately – see watchedRank below)

  // Detailed list used for the left sidebar.  It now shows *all* shows in the
  // watch list (both watched & unwatched) so users can always see the full
  // season list.
  $: fullDetailed = watchList
    .map((w) => {
      const data = anime.find((a) => a.id === w.mediaId);
      return data
        ? {
            ...data,
            customName: w.customName ?? null,
            watched: w.watched ?? Boolean(w.watchedAt)
          }
        : null;
    })
    .filter(Boolean);

  // Client-side ranking list for watched items.  Initially seeded from
  // watchedDetailed (sorted by watchedAt) and updated whenever the user
  // drags items in the ranking sidebar.
  let watchedRank: any[] = [];

  // Seed watchedRank whenever the underlying watched list changes *and* the
  // rank array does not already include the same set of IDs.  This preserves
  // the user’s manual ordering across reactive re-computations triggered by
  // other state (e.g. title-language switch, rename, etc.).
  $: {
    const ids = watchedEntries.map((w) => w.mediaId);
    const rankIds = watchedRank.map((i) => i.id);
    if (ids.length !== rankIds.length || ids.some((id) => !rankIds.includes(id))) {
      // Build fresh detailed list in default watchedAt order
      const detailed = watchedEntries
        .map((w) => {
          const data = anime.find((a) => a.id === w.mediaId);
          return data
            ? {
                ...data,
                customName: w.customName ?? null,
                watchedAt: w.watchedAt ?? null,
                watched: true,
                watchedRank: w.watchedRank ?? null
              }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.watchedRank != null && b.watchedRank != null) return a.watchedRank - b.watchedRank;
          if (a.watchedRank != null) return -1;
          if (b.watchedRank != null) return 1;
          const t1 = a.watchedAt ? new Date(a.watchedAt).getTime() : 0;
          const t2 = b.watchedAt ? new Date(b.watchedAt).getTime() : 0;
          return t1 - t2;
        });

      watchedRank = detailed;
    }
  }

  // Derived values for wheel rendering
  import SliceWorker from '../workers/slice-worker?worker';
  import WatchedRankingSidebar from '../components/WatchedRankingSidebar.svelte';
  const sliceWorker: Worker = new SliceWorker();

  let sliceAngle = 0;
  let sliceData: { start: number; end: number; color: string }[] = [];

  sliceWorker.onmessage = (ev) => {
    sliceAngle = ev.data.sliceAngle;
    sliceData = ev.data.sliceData;
  };

  $: sliceWorker.postMessage({ count: wheelItems.length });

  // radial distance for label (in SVG units, radius is 50)
  const LABEL_R_OUTER = 48; // near rim (SVG units, radius is 50)
  const LABEL_CHAR_LIMIT = 24;

  function spin() {
    if (!wheelItems.length || spinning) return;
    spinning = true;

    const idx = Math.floor(Math.random() * wheelItems.length);
    const segAngle = 360 / wheelItems.length;

    const POINTER_OFFSET = 0; // pointer located at 12 o’clock (top-center)

    // Desired angle of selected slice centre relative to pointer
    const targetAngle = (wheelItems.length - idx - 0.5) * segAngle + POINTER_OFFSET;

    // Current wheel angle (0-359)
    const currentAngle = ((rotation % 360) + 360) % 360;
    let delta = targetAngle - currentAngle;
    if (delta <= 0) delta += 360;
    // add at least 720° extra spins every time
    delta += 720;

    if (wheelEl) {
      wheelEl.style.transition = 'none';
      wheelEl.getBoundingClientRect(); // force reflow
      wheelEl.style.transition = 'transform 4s cubic-bezier(.33,.85,.25,1)';
    }

    rotation += delta;
    selected = wheelItems[idx];
  }

  let showModal = false;

  /**
   * Mark the currently selected series as watched.
   *
   * 1. Update local state so the UI reflects the change immediately.
   * 2. Notify backend so the change is persisted.
   */
  async function markWatched() {
    if (!selected) return;

    await toggleWatched(selected.id, true);
    showModal = false;
  }

  /** Toggle watched flag for a given mediaId */
  async function toggleWatched(id: number, watched: boolean) {
    // update local state
    watchList = watchList.map((w) =>
      w.mediaId === id
        ? {
            ...w,
            watched,
            watchedAt: watched ? new Date().toISOString() : null,
            watchedRank: watched ? (watchedRank.length) : null
          }
        : w
    );

    if ($authToken) {
      try {
        await fetch('/api/list/watched', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${$authToken}`
          },
          body: JSON.stringify({ season, year, mediaId: id, watched })
        });
      } catch (err) {
        console.error('Failed to update watched flag', err);
      }
    }
  }

  // Helper to build SVG arc path
  function polar(cx: number, cy: number, r: number, ang: number) {
    const rad = (ang - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(cx: number, cy: number, r: number, start: number, sweep: number): string {
    const startPt = polar(cx, cy, r, start);
    const endPt = polar(cx, cy, r, start + sweep);
    const large = sweep > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${startPt.x} ${startPt.y} A ${r} ${r} 0 ${large} 1 ${endPt.x} ${endPt.y} Z`;
  }

  /**
   * Get display title based on preference, truncating for wheel labels.
   */
  function getDisplayTitle(item: any): string {
    if (item.customName) return item.customName;
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  /**
   * Get original title based on preference, ignoring any customName.
   */
  function getBaseTitle(item: any): string {
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  function shortTitle(item: any): string {
    const title = getDisplayTitle(item);
    return title.length > LABEL_CHAR_LIMIT ? title.slice(0, LABEL_CHAR_LIMIT - 1) + '…' : title;
  }
</script>

<main class="p-4 flex flex-col gap-8">
  <!-- Controls aligned to header -->
  <div class="w-full md:w-3/4 mx-auto">
    <SeasonSelect
      bind:season
      bind:year
      showListToggle={false}
      showSequelToggle={false}
      hideSequels={false}
      hideInList={false}
      showSearch={false}
    />
  </div>

  <!-- Container: wheel centered in page; watched sidebar positioned absolutely so it doesn't shift wheel -->
  <div class="relative w-full flex justify-center lg:pl-[17rem] lg:pr-[21rem]">
    <div class="flex flex-col items-center mx-auto">
      {#if !wheelItems.length}
        <div class="mt-24 text-center opacity-70">My List for this season is empty.</div>
      {:else}
        <!-- Wheel -->
        <div
          class="relative mt-6 mx-auto overflow-visible"
          style="
            /* Wheel size: 95% of smaller viewport dimension, but limited by available height minus controls */
            /* start shrinking sooner to keep Spin button visible */
            /* increase reserved space so wheel shrinks sooner */
            width: min(95vmin, calc(100vh - 21rem));
            height: min(95vmin, calc(100vh - 21rem));
            max-width: 900px;
            max-height: 900px;
          "
        >
          <!-- Clipped wheel -->
          <div class="overflow-hidden rounded-full w-full h-full">
        <svg
          bind:this={wheelEl}
          viewBox="-50 -50 100 100"
          style="width:100%;height:100%;will-change:transform;backface-visibility:hidden;transform:translateZ(0) rotate({rotation}deg);"
          class="transition-transform pointer-events-none"
        on:transitionend={() => {
          if (spinning) {
            spinning = false;
            showModal = true;
          }
        }}
      >
        <!-- draw slices -->
        {#each sliceData as s}
          <g transform="rotate({s.start})">
            <path d={arcPath(0, 0, 50, 0, sliceAngle)} fill={s.color} />
          </g>
        {/each}

        <!-- draw labels on top -->
        {#each wheelItems as item, i (item.id)}
          {#key $options.titleLanguage + '-' + item.id}
          <!-- rotate label to centre of slice.
               Polar helper uses 0° at 12 o’clock, but CSS/SVG rotate() uses 0° at 3 o’clock → offset -90° -->
          <g transform={`rotate(${sliceAngle * i + sliceAngle / 2 - 90})`}>
            <text
              fill="white"
              font-size="2.5"
              text-anchor="start"
              alignment-baseline="middle"
              transform={`rotate(180) translate(-${LABEL_R_OUTER},0)`}
              style="pointer-events:none;stroke:#000;stroke-width:.25;paint-order:stroke;white-space:pre;">
              {shortTitle(item)}
            </text>
          </g>
          {/key}
        {/each}
        </svg>
      </div>

      <!-- Pointer -->
      <div class="absolute left-1/2 -top-10 -translate-x-1/2 rotate-180 pointer-events-none">
        <svg class="h-8 w-8 fill-primary" viewBox="0 0 24 24"><path d="M12 0l6 12H6z"/></svg>
      </div>
    </div>

    <button class="btn btn-primary mt-8" on:click={spin} disabled={spinning}>Spin</button>
  {/if}
    
  </div> <!-- end wheel column -->

    <!-- List sidebar (shows all items; watched are greyed out) -->
    <aside class="hidden lg:block absolute left-4 top-0 mt-0 w-64 3cols:w-80 max-h-[80vh] overflow-y-auto">
      {#if fullDetailed.length}
        <h3 class="text-lg font-bold mb-4 text-center md:text-left">Unwatched</h3>
        <ul class="flex flex-col gap-3">
          {#each fullDetailed as item (item.id)}
            <li
              class={`flex items-center gap-3 group transition ${item.watched ? 'opacity-40 pointer-events-none' : ''}`}
            >
              <img
                src={item.coverImage?.small ?? item.coverImage?.medium ?? item.coverImage?.large}
                alt=""
                class="w-12 h-16 object-cover rounded shrink-0"
                loading="lazy"
              />

              {#key $options.titleLanguage + '-' + item.id}
                <span
                  class="text-sm flex-1 whitespace-normal break-words force-wrap"
                  title={getDisplayTitle(item)}
                  data-lang={$options.titleLanguage}
                  >{item.customName || getDisplayTitle(item)}</span
                >
              {/key}

              {#if !item.watched}
                <!-- Mark as watched button, appears on hover -->
                <button
                  class="ml-auto opacity-0 group-hover:opacity-100 transition-opacity btn btn-xs btn-circle btn-ghost"
                  on:click={() => {
                    selected = item;
                    showModal = true;
                  }}
                  aria-label="Mark as watched"
                >✓</button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <!-- Watched ranking sidebar -->
    <WatchedRankingSidebar
      list={watchedRank}
      on:update={(e) => {
        // e.detail is an ordered array of anime IDs
        const idOrder = e.detail;
        // Reorder watchedRank to reflect emitted order
        watchedRank = idOrder.map((id) => watchedRank.find((it) => it.id === id)).filter(Boolean);

        // Persist watched ranking via dedicated endpoint
        if ($authToken) {
          fetch('/api/list/rank', {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${$authToken}`
            },
            body: JSON.stringify({ season, year, ids: idOrder })
          });
        }
      }}
      on:unwatch={(e) => toggleWatched(e.detail, false)}
    />
  </div> <!-- end flex container -->

  {#if showModal && selected}
    <dialog open class="modal">
      <div class="modal-box w-full max-w-3xl">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" on:click={() => (showModal = false)}>✕</button>
        {#key $options.titleLanguage + '-' + selected.id}
        <h3 class="font-bold text-lg mb-2" data-lang={$options.titleLanguage}>
          {selected.customName || getDisplayTitle(selected)}
        </h3>
        {/key}
        {#if selected.customName}
          <p class="mb-4 text-sm text-base-content/70">
            {getBaseTitle(selected)}
          </p>
        {/if}
        <img src={selected.coverImage?.extraLarge ?? selected.coverImage?.large ?? selected.coverImage?.medium} alt={selected.title} class="w-56 mx-auto mb-6" />
        <div class="modal-action justify-center">
          <button class="btn btn-primary" on:click={markWatched}>Mark as watched</button>
        </div>
      </div>
    </dialog>
  {/if}
</main>

<style>
  /* Ensure extremely long words wrap while still preferring spaces */
  .force-wrap {
    overflow-wrap: anywhere; /* allows break inside long words only if needed */
  }
</style>