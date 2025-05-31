<script lang="ts">
  export let list: any[] = [];
  import { dragged } from '../stores/drag';
  import { authToken } from '../stores/auth';

  import { createEventDispatcher } from 'svelte';
import { beforeUpdate, afterUpdate, tick } from 'svelte';
  const dispatch = createEventDispatcher();

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
  class="fixed right-4 top-24 bottom-4 z-[9999] min-w-[16rem] w-[calc(12.5vw-1rem)] max-w-[24rem] bg-base-200 p-3 rounded shadow-lg overflow-visible flex flex-col"
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
    <h3 class="text-lg font-bold">My List</h3>
    <span
      class="tooltip tooltip-bottom text-left whitespace-pre-line relative z-[10000]"
      data-tip={`Drag series here from the main grid\nDouble-click an item in My List to change its title`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        class="w-4 h-4 opacity-60 cursor-help"
      >
        <path
          fill-rule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-9 3a1 1 0 012 0v1a1 1 0 11-2 0v-1zm1-8a1 1 0 00-1 1v1a1 1 0 102 0V6a1 1 0 00-1-1z"
          clip-rule="evenodd"
        />
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
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            class="w-4 h-4 opacity-60"
            aria-labelledby="drag-title"
            role="img"
          >
            <title id="drag-title">Drag handle</title>
            <path d="M7 4a1 1 0 11-2 0 1 1 0 012 0zm0 6a1 1 0 11-2 0 1 1 0 012 0zm-1 7a1 1 0 100-2 1 1 0 000 2zm7-13a1 1 0 110-2 1 1 0 010 2zm0 6a1 1 0 110-2 1 1 0 010 2zm-1 7a1 1 0 100-2 1 1 0 000 2z" />
          </svg>

          <button
            type="button"
            class="flex-1 whitespace-normal break-words force-wrap text-left bg-transparent p-0 border-none focus:outline-none"
            title={item.title?.english ?? item.title?.romaji}
            on:dblclick={() => {
              openNameModal(item);
            }}
            on:keydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openNameModal(item);
              }
            }}
          >
            {customNames[item.id] || item.title?.english || item.title?.romaji}
          </button>
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
