<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { options } from '../stores/options';
  import { moveIndex, nudgeTarget } from '../lib/rankPlacement';

  /**
   * The expanded ranking - the whole Watched list at once, opened from
   * the rail's "Expand ranking" once you are done watching. Two views over the
   * same list (Posters / List, remembered per browser). Placing the show you
   * just ranked works exactly as in the rail (click a show to put it ahead of
   * that one, or the arrows); any show can be dragged to a new place. Every
   * change is emitted as the new id order - the parent saves it the same way it
   * saves the rail.
   */
  export let list: any[] = [];
  export let placingId: number | null = null;
  export let spinNextArmed = true;
  export let videoPaused = false;
  const dispatch = createEventDispatcher();

  const VIEW_KEY = 'randomizeRankView';
  let view: 'list' | 'posters' = (() => {
    try { return localStorage.getItem(VIEW_KEY) === 'posters' ? 'posters' : 'list'; } catch { return 'list'; }
  })();
  function setView(v: 'list' | 'posters') {
    view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* a layout preference; fine to lose */ }
  }

  function title(item: any): string {
    if (item.customName) return item.customName;
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }

  $: placingIdx = placingId == null ? -1 : list.findIndex((it) => it.id === placingId);

  function emit(updated: any[] | null) {
    if (!updated) return;
    list = updated;
    dispatch('update', list.map((it) => it.id));
  }

  // Same guard as the rail: a click that lands right after an arrow press or a
  // pick is a repeated press, not a new pick.
  let lastMoveAt = 0;
  const GUARD_MS = 500;
  export function nudge(d: number) {
    if (placingIdx === -1) return;
    const to = nudgeTarget(placingIdx, d, list.length);
    if (to == null) return;
    lastMoveAt = Date.now();
    emit(moveIndex(list, placingIdx, to));
  }
  function pick(i: number) {
    if (placingIdx === -1 || i === placingIdx) return;
    if (Date.now() - lastMoveAt < GUARD_MS) return;
    lastMoveAt = Date.now();
    emit(moveIndex(list, placingIdx, i));
  }

  // Drag any show. Pointer events, not HTML5 drag-and-drop: the browser's own
  // drag showed a faded ghost and never drew our drop line on a real mouse,
  // and automated tests fake that path, so they passed while it was broken.
  // A press only becomes a drag after DRAG_PX of travel, so click-to-place and
  // double-click-to-open are untouched.
  const DRAG_PX = 6;
  let press: { i: number; x: number; y: number; id: number } | null = null;
  let dragIdx = -1;
  /** The show under the pointer and which side of it the dragged show would land. */
  let over: { i: number; after: boolean } | null = null;
  let ghost = { x: 0, y: 0 };
  let suppressClick = false;

  // The same drop line previews a click while placing: hovering a show draws
  // the line where a click would put the placing show (in front of it), so
  // you see where it lands before you commit, not a generic hover highlight.
  // hoverIdx === n is the "put it last" spot after the last show: a click can
  // only put a show in front of another, so without it nothing meant "last".
  let hoverIdx = -1;
  $: lineFrom = dragIdx !== -1 ? dragIdx : placingIdx;
  $: lineAt = dragIdx !== -1 ? over
    : placingIdx === -1 || hoverIdx === -1 ? null
    : hoverIdx === n ? { i: n - 1, after: true }
    : { i: hoverIdx, after: false };
  $: dropTo = lineAt ? lineAt.i + (lineAt.after ? 1 : 0) : -1;
  // No line where the drop would change nothing (on or right beside itself).
  $: showLine = lineFrom !== -1 && lineAt != null && moveIndex(list, lineFrom, dropTo) != null;

  function pressItem(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    press = { i, x: e.clientX, y: e.clientY, id: e.pointerId };
  }
  function movePointer(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    if (dragIdx === -1) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
      dragIdx = press.i;
    }
    ghost = { x: e.clientX, y: e.clientY };
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-drag-idx]') as HTMLElement | null;
    if (!el) return; // in a gap: keep the last line rather than flicker
    const i = +el.dataset.dragIdx!;
    if (i === n) { over = { i: n - 1, after: true }; return; } // the "put it last" spot
    const r = el.getBoundingClientRect();
    over = { i, after: view === 'list' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2 };
  }
  function releasePointer(e: PointerEvent) {
    if (!press || e.pointerId !== press.id) return;
    if (dragIdx !== -1) {
      if (showLine) emit(moveIndex(list, dragIdx, dropTo));
      suppressClick = true; // the click that ends a drag is not a pick
      setTimeout(() => (suppressClick = false), 0);
    }
    cancelDrag();
  }
  function cancelDrag() { press = null; dragIdx = -1; over = null; }
  function clickItem(i: number) {
    if (suppressClick) return;
    pick(i);
  }

  // Sizing: the body's box decides the layout, so every show fits without
  // scrolling at laptop size and bigger screens get bigger rows / posters.
  // PAD keeps the placing ring and the drop line inside the scroll box, which
  // clips them otherwise (top row, first column).
  const PAD = 8;
  let boxW = 0;
  let boxH = 0;
  $: bodyW = Math.max(0, boxW - 2 * PAD);
  $: bodyH = Math.max(0, boxH - 2 * PAD);
  $: n = list.length;
  // While placing, the "put it last" spot needs a cell of its own when the
  // last row (or column) is full, so the layout is sized for one more.
  $: slots = n + (placingIdx !== -1 ? 1 : 0);
  // List: rows always fill the height - no cap (a 44px cap left half of a
  // 1080p screen empty). The column count is whichever gives the biggest
  // text (readable from the couch); on a tie, the one whose rows have room for
  // a two-line title, then the fewest columns. Text grows with the row but is
  // held to the column's width too (~13px per character of what the rank and
  // thumbnail leave), so more, narrower columns never win by being taller.
  // Measured 2026-10-19 on a 31-33 show list: 1366x657 placing after a spin ->
  // 4 cols / 16px two-line; with the Unwatched list docked -> 3 / 15px;
  // 1920x969 -> 3 / 22px two-line; 1100x700 -> 3 / 13-15px.
  const ROW_MIN = 26, ROW_GAP = 2, COL_GAP = 24, LIST_COL_MIN = 220;
  function listShape(c: number) {
    const rows = Math.max(1, Math.ceil(slots / c));
    const fitH = Math.floor((bodyH - (rows - 1) * ROW_GAP) / rows);
    const rowH = Math.max(ROW_MIN, fitH);
    const colW = (bodyW - (c - 1) * COL_GAP) / c;
    let font = Math.max(13, Math.min(22, Math.round(rowH * 0.42), Math.floor((colW - rowH * 0.7 - 50) / 13)));
    // Two lines whenever the row holds them at a size still >= 14px, even if
    // that is a little smaller: 22 shows on a laptop were 21px on one line
    // with 13 of 22 titles cut, where 19px on two lines shows them all.
    const twoLineFont = Math.floor(rowH / 2.6);
    const twoLines = twoLineFont >= font || twoLineFont >= 14;
    if (twoLines) font = Math.min(font, twoLineFont);
    // A layout that fits always beats one that scrolls; among ones that scroll,
    // the least overflow wins. Without this, 75+ shows on a laptop tied at the
    // minimum everywhere and fell to the first candidate - one scrolling column.
    const fits = fitH >= ROW_MIN;
    const score = (fits ? 1e6 : fitH) + font * 100 + Math.min(rowH, font * 2.6);
    return { cols: c, rows, rowH, font, twoLines, score };
  }
  $: listLayout = (() => {
    const maxCols = Math.max(1, Math.floor((bodyW + COL_GAP) / (LIST_COL_MIN + COL_GAP)));
    let best = listShape(1);
    for (let c = 2; c <= maxCols; c++) { const s = listShape(c); if (s.score > best.score) best = s; }
    return best;
  })();
  $: listCols = listLayout.cols;
  $: listRows = listLayout.rows;
  $: rowH = listLayout.rowH;
  $: rowFont = listLayout.font;
  $: twoLines = listLayout.twoLines;
  const GAP = 8;
  $: grid = (() => {
    let best = { cols: 6, w: 0 };
    if (!bodyW || !bodyH || !slots) return best;
    for (let c = 3; c <= 24; c++) {
      const r = Math.ceil(slots / c);
      const availW = (bodyW - (c - 1) * GAP) / c;
      const availH = (bodyH - (r - 1) * GAP) / r;
      // Floor before comparing: once height limits the size, every wider grid
      // ties, and an unrounded compare let the widest win (9 shows came out as
      // 8 + 1). On a tie the fewest columns win, which balances the rows.
      const w = Math.floor(Math.min(availW, availH * 0.705));
      if (w > best.w) best = { cols: c, w };
    }
    return best;
  })();
</script>

<div class="h-full flex flex-col gap-3 bg-base-100 rounded-box shadow-xl p-4 box-border" data-rank-expanded>
  <!-- One line, always: a long show name is cut, never wrapped - a wrap pushed
       Spin next onto a second row (moving it by title length) and took ~56px
       from the posters on a laptop. -->
  <div class="shrink-0 flex flex-nowrap items-center gap-3 min-w-0">
    <h3 class="text-xl font-bold shrink-0">Ranking <span class="text-sm font-normal opacity-60">{n} shows</span></h3>
    <div class="join shrink-0" role="group" aria-label="Ranking view" data-rank-view={view}>
      <button type="button" class="join-item btn btn-sm normal-case {view === 'posters' ? 'btn-neutral' : 'btn-outline'}"
        aria-pressed={view === 'posters'} on:click={() => setView('posters')}>Posters</button>
      <button type="button" class="join-item btn btn-sm normal-case {view === 'list' ? 'btn-neutral' : 'btn-outline'}"
        aria-pressed={view === 'list'} on:click={() => setView('list')}>List</button>
    </div>
    {#if placingIdx !== -1}
      <span class="text-sm ml-2 min-w-0 flex-1 flex items-baseline gap-1.5" title={title(list[placingIdx])}>
        <!-- The name keeps its room and the hint gives way first: the hint
             only repeats what the rail already said. -->
        <b class="text-primary truncate shrink-0 max-w-[65%]">{title(list[placingIdx])}</b>
        <b class="text-primary shrink-0">is #{placingIdx + 1}</b>
        <span class="opacity-70 min-w-0 truncate hidden xl:inline">- click a show to put it {view === 'list' ? 'above' : 'before'} that one, or</span>
      </span>
      <!-- Inline icons: the arrow characters render as emoji on Windows. -->
      <button type="button" class="btn btn-sm btn-square btn-outline shrink-0" data-rank-up
        aria-label={view === 'list' ? 'One place up' : 'One place earlier'} on:click={() => nudge(-1)}>
        <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {#if view === 'list'}<path d="M6 15l6-6 6 6" />{:else}<path d="M15 6l-6 6 6 6" />{/if}
        </svg>
      </button>
      <button type="button" class="btn btn-sm btn-square btn-outline shrink-0" data-rank-down
        aria-label={view === 'list' ? 'One place down' : 'One place later'} on:click={() => nudge(1)}>
        <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {#if view === 'list'}<path d="M6 9l6 6 6-6" />{:else}<path d="M9 6l6 6-6 6" />{/if}
        </svg>
      </button>
    {:else}
      <span class="flex-1"></span>
    {/if}
    {#if videoPaused}<span class="text-xs opacity-60 shrink-0">video paused</span>{/if}
    <button type="button" class="btn btn-outline shrink-0" data-rank-collapse on:click={() => dispatch('collapse')}>Collapse</button>
    {#if placingIdx !== -1}
      <button type="button" class="btn btn-primary min-w-[8.5rem] shrink-0" data-rank-spin-next
        class:btn-disabled={!spinNextArmed} on:click={() => dispatch('spinnext')}>Spin next</button>
    {/if}
  </div>

  <div class="drag-box flex-1 min-h-0 overflow-auto select-none" style="padding: {PAD}px"
    class:dragging={dragIdx !== -1}
    bind:clientWidth={boxW} bind:clientHeight={boxH}>
    {#if view === 'list'}
      <div class="grid gap-x-6 gap-y-0.5" data-rank-list
        style="grid-auto-flow: column; grid-template-columns: repeat({listCols}, minmax(0, 1fr)); grid-template-rows: repeat({listRows}, {rowH}px);">
        {#each list as item, i (item.id)}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="row relative flex items-center gap-2 px-2 rounded min-w-0
              {i === placingIdx ? 'bg-primary/15 ring-2 ring-inset ring-primary' : placingIdx !== -1 ? 'cursor-pointer' : 'cursor-grab hoverable'}"
            class:drop-before={showLine && lineAt?.i === i && !lineAt.after}
            class:drop-after={showLine && lineAt?.i === i && lineAt.after}
            class:opacity-40={dragIdx === i}
            data-rank-board-row={item.id}
            data-drag-idx={i}
            title={title(item)}
            on:pointerenter={() => (hoverIdx = i)}
            on:pointerleave={() => { if (hoverIdx === i) hoverIdx = -1; }}
            on:pointerdown={(e) => pressItem(e, i)}
            on:click={() => clickItem(i)}
            on:dblclick={() => { if (placingIdx === -1) dispatch('view', item); }}>
            <span class="shrink-0 text-right font-extrabold tabular-nums" style="font-size: {rowFont + 1}px; width: {rowFont * 2}px">{i + 1}</span>
            <img class="shrink-0 rounded-sm object-cover pointer-events-none" alt=""
              style="height: {rowH - 6}px; width: {Math.round((rowH - 6) * 0.705)}px"
              src={item.coverImage?.small ?? item.coverImage?.medium ?? item.coverImage?.large} loading="lazy" />
            <span class={twoLines ? 'line-clamp-2 leading-tight' : 'truncate'} style="font-size: {rowFont}px">{title(item)}</span>
          </div>
        {/each}
        {#if placingIdx !== -1}
          <!-- Put it last: the rest of the last column below the last show. -->
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="cursor-pointer" data-place-last data-drag-idx={n} title="Put it last"
            style="grid-row: span {listRows - (n % listRows)}"
            on:pointerenter={() => (hoverIdx = n)}
            on:pointerleave={() => { if (hoverIdx === n) hoverIdx = -1; }}
            on:click={() => clickItem(n)}></div>
        {/if}
      </div>
    {:else}
      <div class="grid justify-center" data-rank-posters
        style="grid-template-columns: repeat({grid.cols}, {grid.w}px); gap: {GAP}px;">
        {#each list as item, i (item.id)}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="card-cell relative group
              {i === placingIdx ? '' : placingIdx !== -1 ? 'cursor-pointer' : 'cursor-grab'}"
            class:drop-left={showLine && lineAt?.i === i && !lineAt.after}
            class:drop-right={showLine && lineAt?.i === i && lineAt.after}
            class:opacity-40={dragIdx === i}
            data-rank-board-card={item.id}
            data-drag-idx={i}
            title={title(item)}
            on:pointerenter={() => (hoverIdx = i)}
            on:pointerleave={() => { if (hoverIdx === i) hoverIdx = -1; }}
            on:pointerdown={(e) => pressItem(e, i)}
            on:click={() => clickItem(i)}
            on:dblclick={() => { if (placingIdx === -1) dispatch('view', item); }}>
            <div class="relative rounded overflow-hidden bg-base-300 {i === placingIdx ? 'ring-4 ring-primary' : placingIdx === -1 ? 'hover-ring' : ''}"
              style="width: {grid.w}px; height: {Math.round(grid.w / 0.705)}px">
              <img class="w-full h-full object-cover pointer-events-none" alt=""
                src={item.coverImage?.large ?? item.coverImage?.medium} loading="lazy" />
              <span class="absolute left-1 top-1 min-w-[1.5rem] h-6 px-1.5 rounded-full bg-neutral text-neutral-content text-xs font-bold flex items-center justify-center tabular-nums">{i + 1}</span>
              <!-- The title is always on the poster: the group reads the wall from
                   the couch, so a hover-only label is no label. Two lines, then cut. -->
              <!-- The clamp sits on the inner span: overflow clips at the padding
                   edge, so clamping the padded box let a sliver of line 3 show. -->
              <span class="absolute inset-x-0 bottom-0 px-1.5 pt-5 pb-1 bg-gradient-to-t from-black/90 via-black/70 to-transparent">
                <!-- overflow-wrap: a word wider than a narrow poster (SNOWBALL at
                     54 shows) breaks onto the next line instead of being clipped. -->
                <span class="font-semibold leading-tight text-white line-clamp-2 [overflow-wrap:anywhere] [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]"
                  style="font-size: {grid.w >= 140 ? 14 : 12}px">{title(item)}</span>
              </span>
            </div>
          </div>
        {/each}
        {#if placingIdx !== -1}
          <!-- Put it last: the rest of the last row after the last poster. -->
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="cursor-pointer" data-place-last data-drag-idx={n} title="Put it last"
            style="grid-column: span {grid.cols - (n % grid.cols)}"
            on:pointerenter={() => (hoverIdx = n)}
            on:pointerleave={() => { if (hoverIdx === n) hoverIdx = -1; }}
            on:click={() => clickItem(n)}></div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<svelte:window on:pointermove={movePointer} on:pointerup={releasePointer} on:pointercancel={cancelDrag} on:blur={cancelDrag} />

<!-- What you are carrying, under the pointer, so the drop line has a subject. -->
{#if dragIdx !== -1}
  <div class="fixed z-[100] pointer-events-none flex items-center gap-2 pl-1 pr-3 py-1 rounded-lg bg-base-100 shadow-xl ring-2 ring-primary max-w-[16rem]"
    style="left: {ghost.x + 12}px; top: {ghost.y + 12}px">
    <img class="w-7 h-10 rounded-sm object-cover shrink-0" alt=""
      src={list[dragIdx]?.coverImage?.small ?? list[dragIdx]?.coverImage?.medium} />
    <span class="text-sm font-semibold truncate">{title(list[dragIdx])}</span>
  </div>
{/if}

<style>
  /* Hover feedback only when nothing is being dragged: mid-drag, the drop line
     is the one thing that says where the show will land. */
  .drag-box:not(.dragging) > div > .hoverable:hover { background: hsl(var(--b2)); }
  .drag-box:not(.dragging) > div > .card-cell:hover .hover-ring { box-shadow: 0 0 0 2px hsl(var(--bc) / 0.3); }
  .dragging, .dragging * { cursor: grabbing !important; }

  /* The drop line: a solid primary bar on the edge the dragged show will take. */
  .row.drop-before::before, .row.drop-after::after,
  .card-cell.drop-left::before, .card-cell.drop-right::after {
    content: '';
    position: absolute;
    background: hsl(var(--p));
    border-radius: 9999px;
    box-shadow: 0 0 6px hsl(var(--p));
  }
  .row.drop-before::before { left: 4px; right: 4px; top: -2px; height: 4px; }
  .row.drop-after::after { left: 4px; right: 4px; bottom: -2px; height: 4px; }
  .card-cell.drop-left::before { top: 4px; bottom: 4px; left: -6px; width: 4px; }
  .card-cell.drop-right::after { top: 4px; bottom: 4px; right: -6px; width: 4px; }
</style>
