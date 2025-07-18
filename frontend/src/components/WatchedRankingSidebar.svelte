<script lang="ts">
  import { options } from '../stores/options';
  import { createEventDispatcher } from 'svelte';

  /**
   * An extremely light-weight sidebar that lets the user rank their watched
   * series.  It supports intra-list drag-and-drop (same behaviour as the main
   * My-List sidebar) but does NOT allow dropping in items from the grid.
   */

  export let list: any[] = [];
  const dispatch = createEventDispatcher();

  // Index of the item currently being dragged; -1 when none.
  let dragIdx: number = -1;

  // Placeholder insertion index while dragging (0 … list.length).  -1 = none.
  let placeholder: number = -1;

  // Reference to the <ul> so we can scroll while dragging near edges.
  let listEl: HTMLUListElement;

  // How many pixels from the top/bottom of the list should auto-scroll kick in
  // while dragging.
  const EDGE_PX = 32;
  let scrollInterval: any = null;

  function startAutoScroll(dir: -1 | 0 | 1) {
    stopAutoScroll();
    if (!dir) return;
    scrollInterval = setInterval(() => {
      if (listEl) listEl.scrollTop += dir * 10;
    }, 16);
  }

  function stopAutoScroll() {
    if (scrollInterval) clearInterval(scrollInterval);
    scrollInterval = null;
  }

  /**
   * Move an item inside the list and emit the new order to the parent.
   */
  function move(from: number, to: number) {
    if (from === to || from < 0 || from >= list.length) return;
    const dest = from < to ? to - 1 : to;

    const updated = [...list];
    const [spliced] = updated.splice(from, 1);
    updated.splice(dest, 0, spliced);
    list = updated;

    // Notify parent with the *ordered* array of IDs so it can persist.
    dispatch('update', list.map((it) => it.id));
  }

  /**
   * Calculate whether we should show the placeholder before or after the given
   * list element based on the cursor Y position.
   */
  function calcPlaceholder(target: HTMLElement, clientY: number, idx: number): number {
    const rect = target.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    return clientY < mid ? idx : idx + 1;
  }

  // Helpers to obtain the display title respecting user preference.
  $: _lang = $options.titleLanguage; // reactive trigger
  function getDisplayTitle(item: any): string {
    if (item.customName) return item.customName;
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
</script>

<aside
  class="hidden lg:block absolute right-4 top-0 mt-0 w-80 overflow-y-auto"
  style="max-height: calc(100dvh - 195px);"
>
  {#if list.length}
    <h3 class="text-lg font-bold mb-4 text-center md:text-left">Watched</h3>
    <ul
      class="flex flex-col gap-2 overflow-y-auto pb-8"
      bind:this={listEl}
      on:dragover={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      }}
      on:drop={(e) => {
        e.preventDefault();
        const dest = placeholder === -1 ? list.length : placeholder;
        if (dragIdx !== -1) move(dragIdx, dest);
        dragIdx = -1;
        placeholder = -1;
      }}
    >
      {#each list as item, i (item.id)}
        <!-- Placeholder before -->
        {#if placeholder === i}
          <li class="h-3 bg-primary/40 rounded transition-all"></li>
        {/if}

        <li
          class={`group p-1 rounded text-sm shadow flex items-center gap-2 cursor-grab bg-base-100 ${dragIdx === i && placeholder !== -1 ? 'invisible' : ''}`}
          draggable="true"
          on:dragstart={() => (dragIdx = i)}
          on:dragend={() => {
            dragIdx = -1;
            placeholder = -1;
            stopAutoScroll();
          }}
          on:dragover={(e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            // currentTarget is always an HTMLElement in this context
            placeholder = calcPlaceholder(e.currentTarget, e.clientY, i);

            // auto-scroll near edges
            if (listEl) {
              const r = listEl.getBoundingClientRect();
              const y = e.clientY;
              let dir = 0;
              if (y < r.top + EDGE_PX) dir = -1;
              else if (y > r.bottom - EDGE_PX) dir = 1;
              startAutoScroll(dir);
            }
          }}
          on:drop={(e) => {
            e.preventDefault();
            if (placeholder !== -1) move(dragIdx, placeholder);
            dragIdx = -1;
            placeholder = -1;
          }}
        >
          <!-- Drag handle icon -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            class="w-5 h-5 opacity-60 shrink-0"
            aria-labelledby="drag-title"
            role="img"
          >
            <title id="drag-title">Drag handle</title>
            <path d="M10 4a2 2 0 11-4 0 2 2 0 014 0zm0 8a2 2 0 11-4 0 2 2 0 014 0zm-2 8a2 2 0 100-4 2 2 0 000 4zm8-16a2 2 0 114 0 2 2 0 01-4 0zm0 8a2 2 0 114 0 2 2 0 01-4 0zm2 8a2 2 0 100-4 2 2 0 000 4z" />
          </svg>

          <!-- Cover image -->
          <img
            src={item.coverImage?.small ?? item.coverImage?.medium ?? item.coverImage?.large}
            alt=""
            class="w-12 h-16 object-cover rounded shrink-0"
            loading="lazy"
          />

          {#key $options.titleLanguage + '-' + item.id}
            <span
              class="flex-1 whitespace-normal break-words force-wrap"
              title={getDisplayTitle(item)}
              data-lang={$options.titleLanguage}
              >{getDisplayTitle(item)}</span
            >
          {/key}

          <!-- Unwatch button appears on hover -->
          <button
            class="ml-auto opacity-0 group-hover:opacity-100 transition-opacity btn btn-xs btn-circle btn-ghost"
            on:click={() => dispatch('unwatch', item.id)}
            aria-label="Mark as unwatched"
          >✕</button>
        </li>
      {/each}

      <!-- Placeholder at end -->
      {#if placeholder === list.length}
        <li class="h-3 bg-primary/40 rounded transition-all"></li>
      {/if}
    </ul>
  {/if}
</aside>

<style>
  /* Ensure extremely long words wrap while still preferring spaces */
  .force-wrap {
    overflow-wrap: anywhere;
  }
</style>
