<script lang="ts">
  import { options } from '../stores/options';
  export let list: any[] = [];
  // Season & year of the current list (e.g. "SPRING", 2025)
  export let season: string;
  export let year: number;
  // Current user's display name (nullable when not logged in)
  export let user: string | null = null;
import { dragged } from '../stores/drag';
import { authToken } from '../stores/auth';
// Reactive trigger for title-language changes
$: _lang = $options.titleLanguage;
/**
 * Get display title based on user's language preference and custom labels.
 */
function getItemTitle(item: any): string {
  const custom = customNames[item.id];
  if (custom) return custom;
  const lang = $options.titleLanguage;
  if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
  if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
  return item.title?.english || item.title?.romaji || item.title?.native || '';
}

  import { createEventDispatcher } from 'svelte';
import { beforeUpdate, afterUpdate, tick } from 'svelte';
  const dispatch = createEventDispatcher();

  /* --------------------------------------------------------------
   * Share-as-image helper
   * ------------------------------------------------------------*/
  let sidebarEl: HTMLElement; // reference to <aside>

  async function shareMyList() {
    if (!sidebarEl) return;

    // Target the <ul> so we can temporarily expand it
    const ul = listEl;
    if (!ul) return;

    // Save original inline styles so we can restore them later
    const ulOriginal = {
      maxHeight: ul.style.maxHeight,
      overflowY: ul.style.overflowY,
      whiteSpace: ul.style.whiteSpace,
      width: ul.style.width
    } as Record<string, string>;

    // Save original inline styles for the sidebar so we can restore them later
    const sidebarOriginalWidth = sidebarEl.style.width;
    const sidebarOriginalHeight = sidebarEl.style.height;
    const sidebarOriginalTop = sidebarEl.style.top;
    const sidebarOriginalBottom = sidebarEl.style.bottom;
    const sidebarOriginalMinWidth = sidebarEl.style.minWidth;
    const sidebarOriginalMaxWidth = sidebarEl.style.maxWidth;

    // Expand to show full list with no scrollbars & keep titles on one line
    ul.style.maxHeight = 'none';
    ul.style.overflowY = 'visible';
    ul.style.whiteSpace = 'nowrap';
    ul.style.width = 'max-content';
    sidebarEl.style.width = 'max-content';
    // Allow full-content width by removing class-based min/max constraints
    sidebarEl.style.minWidth = '0';
    sidebarEl.style.maxWidth = 'none';

    // Hide the share button itself so it doesn't appear in the capture
    const shareBtn = sidebarEl.querySelector('[data-share-btn]') as HTMLElement | null;
    const btnDisplay = shareBtn?.style.display ?? '';
    if (shareBtn) shareBtn.style.display = 'none';

    // Expand aside to fit full content height (override fixed-top/bottom constraints)
    sidebarEl.style.height = `${sidebarEl.scrollHeight}px`;
    sidebarEl.style.top = 'auto';
    sidebarEl.style.bottom = 'auto';

    try {
      // Dynamically import only when user clicks Share so html-to-image is
      // not loaded during initial page render. Package is present in
      // dependencies so Vite can resolve it without extra directives.
      // Dynamically import html-to-image; use variable specifier so Vite does
      // not try to pre-bundle. Fallback to CDN if not installed inside the
      // container (e.g. node_modules volume wasn’t rebuilt).
      // Lazy-load html-to-image with a literal specifier so Vite can analyse
      // the import and keep quiet.
      // Import html2canvas from a CDN; it is more tolerant and avoids the
      // blank-image issue we've observed with html-to-image.
      const html2canvas = (
        await import(
          /* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm'
        )
      ).default;
      // Ensure we capture from the very top so the heading is fully visible.
      sidebarEl.scrollTop = 0;

      // Work-around for html2canvas occasionally clipping text: force a
      // slightly larger line-height on the heading during capture.
      const headingEl = sidebarEl.querySelector('h3');
      const prevLineHeight = headingEl ? headingEl.style.lineHeight : '';
      const prevPadding = headingEl ? headingEl.style.paddingBottom : '';
      if (headingEl) {
        headingEl.style.lineHeight = '1.4';
        headingEl.style.paddingBottom = '4px'; // add descent space
      }

      // Temporarily hide poster <img> elements to avoid CORS-tainted canvas
      // (remote images cause the captured canvas to be cleared, resulting in
      // a blank white output). They are restored in the finally block.
      const posters: HTMLImageElement[] = Array.from(
        sidebarEl.querySelectorAll('img')
      );
      const posterDisplay = posters.map((p) => p.style.display);
      posters.forEach((p) => (p.style.display = 'none'));

      const canvas = await html2canvas(sidebarEl, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true
      });
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);

      const w = window.open();
      if (w) {
        // Write a complete HTML document so the browser renders the image
        // immediately instead of keeping a blank about:blank page.
        w.document.open();
        w.document.write(`<!DOCTYPE html><html><head><meta charset=\"utf-8\" /><title>My Anime List</title><style>html,body{margin:0;padding:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#fff} img{max-width:100vw;max-height:100vh;width:auto;height:auto}</style></head><body><img src=\"${dataUrl}\" alt=\"My List\" /></body></html>`);
        w.document.close();
      }
    } catch (e) {
      console.error('Failed to export list', e);
    } finally {
      // Restore original styles no matter what
      Object.assign(ul.style, ulOriginal);
      // Restore sidebar width and remove overrides
      sidebarEl.style.width = sidebarOriginalWidth;
      sidebarEl.style.minWidth = sidebarOriginalMinWidth;
      sidebarEl.style.maxWidth = sidebarOriginalMaxWidth;
      // Restore sidebar height and positioning
      sidebarEl.style.height = sidebarOriginalHeight;
      sidebarEl.style.top = sidebarOriginalTop;
      sidebarEl.style.bottom = sidebarOriginalBottom;
      if (shareBtn) shareBtn.style.display = btnDisplay;
      // restore heading line-height
      if (headingEl) {
        headingEl.style.lineHeight = prevLineHeight;
        headingEl.style.paddingBottom = prevPadding;
      }
      posters.forEach((p, idx) => (p.style.display = posterDisplay[idx]));
    }
  }

  /* --------------------------------------------------------------
   * List manipulation helpers
   * ------------------------------------------------------------*/
  async function addItemAt(item: any, index: number) {
    if (list.find((i) => i.id === item.id)) return; // avoid duplicates

    const prevScroll = listEl?.scrollTop ?? null;

    const updated = [...list];
    updated.splice(index, 0, item);
    list = updated;

    // scroll restoration handled globally in afterUpdate

    dispatch(
      'update',
      list.map((a) => ({ mediaId: a.id, customName: customNames[a.id] ?? null, watchedAt: a.watchedAt ?? null }))
    );
  }

  const addItemToEnd = (item: any) => addItemAt(item, list.length);

  async function move(from: number, to: number) {
    if (from === to || from < 0 || from >= list.length) return;
    const prevScroll = listEl?.scrollTop ?? null;

    const dest = from < to ? to - 1 : to; // adjust if moving downwards
    const updated = [...list];
    const [spliced] = updated.splice(from, 1);
    updated.splice(dest, 0, spliced);
    list = updated;

    // scroll restoration handled globally
    dispatch(
      'update',
      list.map((a) => ({ mediaId: a.id, customName: customNames[a.id] ?? null, watchedAt: a.watchedAt ?? null }))
    );
  }

  // Index of item being dragged from inside the list (-1 when dragging from grid)
  let dragIdx: number = -1;

  // Placeholder index where the drop would occur (0..list.length). -1 = none
  let placeholder: number = -1;

  // Custom labels keyed by mediaId
  let customNames: Record<number, string> = {};

  /* --------------------------------------------------------------
   * Custom name modal state & helpers
   * ------------------------------------------------------------*/
  let modal: HTMLDialogElement;
  let editingItem: any = null; // item currently being renamed
  let modalName: string = '';
  let nameInput: HTMLInputElement;

  // Whether to open rename dialog automatically when adding from grid (bound from parent)
  export let autoRename: boolean = false;

  function openNameModal(item: any) {
    editingItem = item;
    modalName = customNames[item.id] ?? '';
    modal?.showModal();

    // Focus the input after modal renders
    tick().then(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  }

  function closeModal() {
    modal?.close();
    editingItem = null;
  }

  function saveName() {
    if (!editingItem) return;

    const trimmed = modalName.trim();
    if (trimmed) {
      customNames[editingItem.id] = trimmed;
    } else {
      delete customNames[editingItem.id];
    }

    // notify parent so it can persist
    dispatch(
      'update',
      list.map((a) => ({ mediaId: a.id, customName: customNames[a.id] ?? null, watchedAt: a.watchedAt ?? null }))
    );

    closeModal();
  }

  function removeEditingItem() {
    if (!editingItem) return;
    list = list.filter((it) => it.id !== editingItem.id);
    dispatch(
      'update',
      list.map((a) => ({ mediaId: a.id, customName: customNames[a.id] ?? null, watchedAt: a.watchedAt ?? null }))
    );
    closeModal();
  }

// Populate from initial list (runs whenever list changes)
$: {
  for (const it of list) {
    if (it.customName && !customNames[it.id]) {
      customNames[it.id] = it.customName;
    }
  }
}

  function overListItem(target: EventTarget): boolean {
    return (target as HTMLElement).closest('li') !== null;
  }

  /**
   * Determine placeholder index (before/after current list item) based on
   * cursor position.
   */
  function calcPlaceholder(target: EventTarget, y: number, idx: number): number {
    const rect = (target as HTMLElement).getBoundingClientRect();
    const before = y < rect.top + rect.height / 2;
    return before ? idx : idx + 1;
  }

  // Reference to the <ul> list for more precise placeholder calculation
  let listEl: HTMLUListElement;

  /* --------------------------------------------------------------
   * Auto-scroll when dragging near top/bottom & wheel scroll helper
   * ------------------------------------------------------------*/
  const EDGE_PX = 40; // distance from edge to start auto scroll
  const SCROLL_SPEED = 12; // px per tick
  let scrollTimer: any = null;

  function startAutoScroll(dir: -1 | 0 | 1) {
    if (dir === 0) {
      stopAutoScroll();
      return;
    }
    if (scrollTimer) return; // already running
    scrollTimer = setInterval(() => {
      listEl?.scrollBy({ top: dir * SCROLL_SPEED, behavior: 'auto' });
    }, 20);
  }

  function stopAutoScroll() {
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
  }

  // Generic scroll preservation across any reactive update
  let _savedScroll = 0;
  beforeUpdate(() => {
    if (listEl) _savedScroll = listEl.scrollTop;
  });

  afterUpdate(() => {
    if (listEl) listEl.scrollTop = _savedScroll;
  });


</script>

<style>
  /* allow long single-word titles to wrap when needed */
  .force-wrap {
    overflow-wrap: anywhere;
  }
</style>

<!-- global wheel handler to allow scrolling while dragging -->


<aside
  bind:this={sidebarEl}
  class="fixed right-4 top-24 bottom-4 z-[9999] \
    min-w-[14.5rem] 2cols:min-w-[17.5rem] \
    w-[calc(12.5vw-1rem)] max-w-[24rem] \
    bg-base-200 p-3 rounded shadow-lg overflow-visible flex flex-col"
  on:dragover={(e) => {
    e.preventDefault();

    // Auto-scroll when near edges while dragging
    if (listEl) {
      const rect = listEl.getBoundingClientRect();
      const y = e.clientY;
      let dir = 0;
      if (y < rect.top + EDGE_PX) dir = -1;
      else if (y > rect.bottom - EDGE_PX) dir = 1;
      startAutoScroll(dir);
    }

    // When dragging over empty space in the sidebar we keep the current
    // placeholder unless the cursor is below the last list item – in that
    // case we show it at the very end. This prevents flickering caused by
    // rapidly alternating events on the gaps created by `space-y-*`.
    if (!overListItem(e.target)) {
      if (listEl) {
        const ulRect = listEl.getBoundingClientRect();
        if (e.clientY > ulRect.bottom) {
          placeholder = list.length; // after last item
        }
      }
    }
  }}
  on:dragleave={(e) => {
    if (e.currentTarget === e.target) {
      placeholder = -1; // left sidebar
      stopAutoScroll();
    }
  }}
  on:drop={(e) => {
    e.preventDefault();
    const fromGrid = dragIdx === -1; // true when dragging in from AnimeGrid

    if (fromGrid && $dragged) {
      const idx = placeholder === -1 ? list.length : placeholder;
      addItemAt($dragged, idx);
      if (autoRename) openNameModal($dragged);
    } else if (!fromGrid && placeholder !== -1) {
      move(dragIdx, placeholder);
    }

    // Reset state
    dragIdx = -1;
    placeholder = -1;

    stopAutoScroll();
  }}
>
  <div class="flex items-start justify-between gap-2 mb-2">
    <div class="flex-1 min-w-0">
      <h3 class="text-lg font-bold leading-tight truncate">
        {season} {year} – {user ?? 'Guest'}
      </h3>
      <div class="text-sm opacity-70">My List</div>
    </div>

    <!-- Share button -->
    <button
      class="btn btn-xs btn-ghost" title="Share list as image" on:click={shareMyList} data-share-btn
    >
      <!-- Material Design share icon, matching main grid copy icon style -->
      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.03-.47-.09-.7l7.02-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7l-7.02 4.11c-.54-.5-1.25-.81-2.04-.81-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.17c-.05.21-.08.43-.08.65 0 1.72 1.39 3.11 3.11 3.11 1.72 0 3.11-1.39 3.11-3.11s-1.39-3.11-3.11-3.11z"/>
      </svg>
    </button>

    <span
      class="tooltip tooltip-left text-left whitespace-pre-line relative z-[10000]"
      data-tip={`Drag series here from the main grid\nDouble-click an item in My List to change its title`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 opacity-60 cursor-help"
        fill="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path fill="none" d="M0 0h24v24H0z"/>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10
                 10-4.48 10-10S17.52 2 12 2zm0 18
                 c-4.41 0-8-3.59-8-8s3.59-8 8-8
                 8 3.59 8 8-3.59 8-8 8z"/>
        <path d="M11 16h2v-2h-2v2zm0-4h2V7h-2v5z"/>
      </svg>
    </span>
  </div>

  {#if $authToken}
    <label class="flex items-center gap-2 text-sm mb-3 select-none cursor-pointer">
      <input type="checkbox" class="checkbox checkbox-sm" bind:checked={autoRename} />
      Prompt rename when adding
    </label>
  {/if}

  {#if list.length === 0}
    <div class="text-sm text-base-content/60">Drag series here</div>
  {:else}
    <ul class="space-y-2 overflow-y-auto max-h-[calc(100vh-10rem)] pb-8" bind:this={listEl}>
      {#each list as item, i (item.id)}
        <!-- Placeholder before item -->
        {#if placeholder === i}
          <li class="h-3 bg-primary/40 rounded transition-all"></li>
        {/if}

        <li
          class={
            `p-2 rounded text-sm shadow flex items-center gap-2 cursor-grab ` +
            (customNames[item.id]
              ? 'bg-primary/10 hover:bg-primary/20 '
              : 'bg-base-100 ') +
            (dragIdx === i && placeholder !== -1 ? 'invisible' : '')
          }
          draggable="true"
          on:dragstart={() => (dragIdx = i)}
          on:dragend={() => {
            dragIdx = -1;
            placeholder = -1;
            stopAutoScroll();
          }}
          on:dragover={(e) => {
            e.preventDefault();
            placeholder = calcPlaceholder(e.currentTarget, e.clientY, i);

            // auto scroll when hovering list item near edges
            if (listEl) {
              const rect = listEl.getBoundingClientRect();
              const y = e.clientY;
              let dir = 0;
              if (y < rect.top + EDGE_PX) dir = -1;
              else if (y > rect.bottom - EDGE_PX) dir = 1;
              startAutoScroll(dir);
            }
          }}
          on:drop={(e) => {
            e.preventDefault();

            const fromGrid = dragIdx === -1;
            if (fromGrid && $dragged) {
              addItemAt($dragged, placeholder === -1 ? list.length : placeholder);
              if (autoRename) openNameModal($dragged);
            } else if (!fromGrid && placeholder !== -1) {
              move(dragIdx, placeholder);
            }

            dragIdx = -1;
            placeholder = -1;
          }}>
          <!-- Material ‘grip-vertical’ icon (six dots) to match Copy/Settings icons -->
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

          {#key $options.titleLanguage + '-' + item.id}
          <button
            type="button"
            class="flex-1 whitespace-normal break-words force-wrap text-left bg-transparent p-0 border-none focus:outline-none"
            title={getItemTitle(item)}
            data-lang={$options.titleLanguage}
            on:dblclick={() => openNameModal(item)}
            on:keydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openNameModal(item);
              }
            }}
          >
            {getItemTitle(item)}
          </button>
          {/key}
        </li>
      {/each}

      <!-- Placeholder at end -->
      {#if placeholder === list.length}
        <li class="h-3 bg-primary/40 rounded transition-all"></li>
      {/if}
    </ul>
  {/if}
</aside>



<!-- Custom name modal (uses native <dialog>) -->
<dialog class="modal" bind:this={modal} on:cancel={closeModal}>
  {#if editingItem}
    <div class="modal-box w-11/12 max-w-2xl">
      <h3 class="font-bold text-lg mb-4">Set Custom Name</h3>

      <div class="flex flex-col sm:flex-row gap-4">
        {#if editingItem.coverImage?.medium || editingItem.coverImage?.large}
          <img
            src={editingItem.coverImage?.medium ?? editingItem.coverImage?.large}
            alt={editingItem.title?.english ?? editingItem.title?.romaji}
            class="w-40 h-auto rounded shadow hidden sm:block"
          />
        {/if}

        <div class="flex-1 min-w-0">
          <h4 class="font-semibold mb-1 truncate">
            {editingItem.title?.english || editingItem.title?.romaji}
          </h4>

          {#if editingItem.description}
            <div class="text-sm max-h-40 overflow-y-auto mb-4 whitespace-pre-wrap">
              {@html editingItem.description}
            </div>
          {/if}

          <div class="form-control w-full">
            <label class="label px-0 pb-1">
              <span class="label-text">Custom name</span>
            </label>
            <input
              type="text"
              placeholder="Enter name…"
              bind:value={modalName}
              class="input input-bordered w-full"
              bind:this={nameInput}
              on:keydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  saveName();
                }
              }}
              on:keyup={(e) => {
                // Prevent the bubbling Enter key from reopening modal
                if (e.key === 'Enter') e.stopPropagation();
              }}
            />
          </div>
        </div>
      </div>

      <div class="modal-action mt-6 flex items-center justify-between flex-wrap gap-3">
        <button class="btn btn-error" on:click={removeEditingItem}>Remove from My List</button>

        <div class="flex gap-2 ml-auto">
          <button class="btn btn-ghost" on:click={closeModal}>Cancel</button>
          <button class="btn btn-primary" on:click={saveName}>Save</button>
        </div>
      </div>
    </div>
  {/if}
</dialog>
