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

// ---------------------------------------------------------------------------
// Mobile-friendly behaviour
// ---------------------------------------------------------------------------
// `collapsed` indicates whether the sidebar is currently hidden (slid outside
// of the viewport).  We expose a local toggle button on small screens to let
// the user minimise / restore the list so the Anime grid becomes visible on a
// phone.
let collapsed = false;

function hideSidebar() {
  collapsed = true;
}

function showSidebar() {
  collapsed = false;
}

$: collapsedClass = collapsed ? 'translate-x-full sm:translate-x-0' : '';
  const dispatch = createEventDispatcher();

  /* --------------------------------------------------------------
   * Share-as-image helper
   * ------------------------------------------------------------*/
  let sidebarEl: HTMLElement; // reference to <aside>

  async function shareMyList() {
    if (!sidebarEl) return;

    /* ----------------------------------------------------------
     * Clone sidebar so we never mutate the live layout
     * --------------------------------------------------------*/
    const workEl = sidebarEl.cloneNode(true) as HTMLElement;

    /* Wrap clone in a container so we can easily measure exact width/height
       without interference from Tailwind fixed/top/bottom utilities that
       exist on the real sidebar. */
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.top = '0';
    wrapper.style.left = '-10000px';
    wrapper.style.overflow = 'hidden';
    wrapper.style.margin = '0';

    // Clean positioning utilities from the clone to prevent full-viewport
    // height.
    workEl.classList.forEach((cls) => {
      if (/^top-/.test(cls) || /^bottom-/.test(cls) || cls === 'h-full' || cls.includes('inset')) {
        workEl.classList.remove(cls);
      }
    });

    workEl.style.top = 'auto';
    workEl.style.bottom = 'auto';
    workEl.style.position = 'static';

    wrapper.appendChild(workEl);
    document.body.appendChild(wrapper);

    // Target the <ul> inside the clone for sizing tweaks
    const ul = workEl.querySelector('ul');
    if (!ul) {
      workEl.remove();
      return;
    }

    // Snapshot entire inline-style attribute for later restoration. This way
    // we can roll back in one shot instead of tracking each property.
    const ulOriginalStyleAttr = ul.getAttribute('style');
    const sidebarOriginalStyleAttr = sidebarEl.getAttribute('style');

    // Expand to show full list with no scrollbars & keep titles on one line
    // Remove Tailwind scroll-related classes from the clone to avoid embedded
    // scrollbars in the captured image.
    ul.classList.forEach((cls) => {
      if (/max-h|overflow-y-auto/.test(cls)) ul.classList.remove(cls);
    });

    ul.style.maxHeight = 'none';
    ul.style.height = 'auto';
    ul.style.overflowY = 'visible';
    ul.style.overflowX = 'visible';
    ul.style.whiteSpace = 'nowrap';
    ul.style.width = 'max-content';

    workEl.style.width = 'max-content';

    // Ensure the heading isn’t clipped vertically in the capture.
    const heading = workEl.querySelector('h3') as HTMLElement | null;
    if (heading) {
      heading.style.lineHeight = '1.45';
      heading.style.paddingBottom = '8px';
    }
    workEl.style.padding = '0';

    // Wait for layout pass so we can compute correct widths and avoid title
    // wrapping.
    await tick();

    // Let the entire sidebar dictate width (includes heading + padding) then
    // add a tiny buffer so longest text never clips.
    const targetWidth = workEl.scrollWidth + 8;
    workEl.style.width = `${targetWidth}px`;
    // Allow full-content width by removing class-based min/max constraints
    workEl.style.minWidth = '0';
    workEl.style.maxWidth = 'none';

    // (No changes to original sidebar now that we use a clone)

    // Hide the share button itself so it doesn't appear in the capture
    const shareBtn = workEl.querySelector('[data-share-btn]') as HTMLElement | null;
    const btnDisplay = shareBtn?.style.display ?? '';
    if (shareBtn) shareBtn.style.display = 'none';

    // Hide the “Prompt rename” toggle so it doesn’t appear in the exported
    // image. We locate the label by its text content to stay resilient to
    // markup tweaks.
    const renameLabel = Array.from(workEl.querySelectorAll('label')).find((l) =>
      l.textContent?.trim().startsWith('Prompt rename')
    ) as HTMLElement | undefined;
    const renameDisplay = renameLabel?.style.display ?? '';
    if (renameLabel) renameLabel.style.display = 'none';

    // Eliminate possible scrollbars inside the list.
    ul.style.overflowY = 'visible';
    ul.style.overflowX = 'visible';
    ul.style.maxHeight = 'none';
    ul.style.height = 'auto';

    // Re-compute height now that width is fixed.
    workEl.style.height = `${workEl.scrollHeight}px`;

    try {
      // Dynamically import only when user clicks Share so html-to-image is
      // not loaded during initial page render. Package is present in
      // dependencies so Vite can resolve it without extra directives.
      // Dynamically import html-to-image; use variable specifier so Vite does
      // not try to pre-bundle. Fallback to CDN if not installed inside the
      // container (e.g. node_modules volume wasn’t rebuilt).
      // Lazy-load html-to-image with a literal specifier so Vite can analyse
      // the import and keep quiet.
      // Dynamically import the `dom-to-image-more` library only when the user
      // clicks Share so it doesn’t bloat the initial bundle.
      const domToImageMod = await import(
        /* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/dom-to-image-more@3.2.0/+esm'
      );
      // The library exports its API both as default and as named exports. We
      // normalise so `toJpeg` is always available regardless of the bundle
      // format.
      const toJpeg = (domToImageMod.toJpeg ?? domToImageMod.default?.toJpeg) as (
        node: HTMLElement,
        opts: any
      ) => Promise<string>;
      // Ensure we capture from the very top so the heading is fully visible.
      workEl.scrollTop = 0;

      // Determine background colour to use for the capture (fallback to first
      // list item’s background if the sidebar is transparent).
      const firstItem = workEl.querySelector('li');
      const bgOverride = firstItem
        ? getComputedStyle(firstItem).backgroundColor || '#ffffff'
        : '#ffffff';

      // Measure wrapper to include any box-shadow/padding adjustments
      await tick();
      let { width: captureWidth, height: captureHeight } = wrapper.getBoundingClientRect();

      // Add 2-px safety buffer so nothing is clipped on the right.
      captureWidth += 2;
      wrapper.style.width = `${captureWidth}px`;
      wrapper.style.height = `${captureHeight}px`;

      // heading line-height already adjusted earlier on clone; do not touch
      // original sidebar.

      // Temporarily hide poster <img> elements to avoid CORS-tainted canvas
      // (remote images cause the captured canvas to be cleared, resulting in
      // a blank white output). They are restored in the finally block.
      const posters: HTMLImageElement[] = Array.from(
        workEl.querySelectorAll('img')
      );
      const posterDisplay = posters.map((p) => p.style.display);
      posters.forEach((p) => (p.style.display = 'none'));

      // Add a temporary style element that forces all borders transparent so
      // dom-to-image doesn’t fall back to white when CSS variables are lost.
      const borderFix = document.createElement('style');
      borderFix.textContent = '*{border-color:transparent !important;}';
      workEl.prepend(borderFix);

      // Remove list-item borders—they render as white lines in the exported
      // image because CSS variables aren’t resolved in the cloned DOM.
      const items: HTMLLIElement[] = Array.from(workEl.querySelectorAll('li'));
      const itemBorders = items.map((it) => it.style.border);
      items.forEach((it) => (it.style.border = 'none'));

      const dataUrl = await toJpeg(wrapper, {
        bgcolor: bgOverride,
        quality: 0.95,
        cacheBust: true,
        pixelRatio: 2,
        width: captureWidth,
        height: captureHeight
      });

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
      // Nothing to restore on live DOM; we only manipulated the clone.
      // no need to restore shareBtn visibility on live DOM – only clone was affected
      if (renameLabel) renameLabel.style.display = renameDisplay;
      posters.forEach((p, idx) => (p.style.display = posterDisplay[idx]));
      borderFix.remove();
      // restore list-item borders in clone (redundant but safe)
      items.forEach((it, idx) => (it.style.border = itemBorders[idx]));
      wrapper.remove();
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

  // Expose helper so parent components can trigger the rename modal after
  // programmatically adding an item (e.g. via “watched trailer” action).
  export function promptRenameFor(id: number) {
    const item = list.find((it) => it.id === id);
    if (item) openNameModal(item);
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
  class="fixed z-40 \
    right-0 sm:right-4 \
    top-0 sm:top-24 \
    bottom-0 sm:bottom-4 \
    bg-base-200 p-3 rounded sm:rounded shadow-lg overflow-visible flex flex-col \
    w-full sm:w-[calc(12.5vw-1rem)] max-w-none sm:max-w-[24rem] \
    min-w-0 sm:min-w-[14.5rem] 2cols:sm:min-w-[17.5rem] \
    pl-4 sm:pl-0 \
    transition-transform duration-300 transform {collapsedClass}"
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
  <!-- Slide/hide handle shown on mobile. Appears as a small tab anchored to the
       left edge of the sidebar. -->
  <button
    class="sm:hidden absolute left-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-l px-1 py-6 shadow flex items-center justify-center"
    title="Hide My List"
    on:click={hideSidebar}
    aria-label="Hide My List"
  >
    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  </button>
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

    <!-- (button removed: new slide tab added below) -->

    <span
      class="tooltip tooltip-left text-left whitespace-pre-line relative z-45"
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

<!-- Slide-in tab to restore the sidebar when collapsed (mobile only) -->
{#if collapsed}
  <button
    class="sm:hidden fixed z-30 right-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-r px-1 py-6 shadow flex items-center justify-center"
    style="width: 1.25rem;"
    on:click={showSidebar}
    title="Show My List"
    aria-label="Show My List"
  >
    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
  </button>
{/if}



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
