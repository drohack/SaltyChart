<script lang="ts">
  export let list: any[] = [];
  import { dragged } from '../stores/drag';
  import { authToken } from '../stores/auth';

  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();

  /* --------------------------------------------------------------
   * List manipulation helpers
   * ------------------------------------------------------------*/
  function addItemAt(item: any, index: number) {
    if (list.find((i) => i.id === item.id)) return; // avoid duplicates
    const updated = [...list];
    updated.splice(index, 0, item);
    list = updated;
    dispatch('update', list.map((a) => ({ mediaId: a.id })));
  }

  const addItemToEnd = (item: any) => addItemAt(item, list.length);

  function move(from: number, to: number) {
    if (from === to || from < 0 || from >= list.length) return;
    const dest = from < to ? to - 1 : to; // adjust if moving downwards
    const updated = [...list];
    const [spliced] = updated.splice(from, 1);
    updated.splice(dest, 0, spliced);
    list = updated;
    dispatch('update', list.map((a) => ({ mediaId: a.id })));
  }

  // Index of item being dragged from inside the list (-1 when dragging from grid)
  let dragIdx: number = -1;

  // Placeholder index where the drop would occur (0..list.length). -1 = none
  let placeholder: number = -1;

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
</script>

<aside
  class="fixed right-4 top-24 min-w-[16rem] w-[calc(12.5vw-1rem)] max-w-[24rem] bg-base-200 p-3 rounded shadow-lg max-h-[calc(100vh-6rem)] overflow-y-auto"
  on:dragover={(e) => {
    e.preventDefault();
    // If not over a specific list item, place placeholder at end
    if (!overListItem(e.target)) placeholder = list.length;
  }}
  on:dragleave={(e) => {
    if (e.currentTarget === e.target) placeholder = -1; // left sidebar
  }}
  on:drop={(e) => {
    e.preventDefault();
    const fromGrid = dragIdx === -1; // true when dragging in from AnimeGrid

    if (fromGrid && $dragged) {
      const idx = placeholder === -1 ? list.length : placeholder;
      addItemAt($dragged, idx);
    } else if (!fromGrid && placeholder !== -1) {
      move(dragIdx, placeholder);
    }

    // Reset state
    dragIdx = -1;
    placeholder = -1;
  }}
>
  <h3 class="text-lg font-bold mb-2">My List</h3>

  {#if list.length === 0}
    <div class="text-sm text-base-content/60">Drag series here</div>
  {:else}
    <ul class="space-y-2">
      {#each list as item, i (item.id)}
        <!-- Placeholder before item -->
        {#if placeholder === i}
          <li class="h-2 bg-primary/40 rounded transition-all"></li>
        {/if}

        <li
          class="bg-base-100 p-2 rounded text-sm shadow"
          draggable="true"
          on:dragstart={() => (dragIdx = i)}
          on:dragend={() => {
            dragIdx = -1;
            placeholder = -1;
          }}
          on:dragover={(e) => {
            e.preventDefault();
            placeholder = calcPlaceholder(e.currentTarget, e.clientY, i);
          }}
          on:drop={(e) => {
            e.preventDefault();

            const fromGrid = dragIdx === -1;
            if (fromGrid && $dragged) {
              addItemAt($dragged, placeholder === -1 ? list.length : placeholder);
            } else if (!fromGrid && placeholder !== -1) {
              move(dragIdx, placeholder);
            }

            dragIdx = -1;
            placeholder = -1;
          }}
        >
          {item.title?.english ?? item.title?.romaji}
        </li>
      {/each}

      <!-- Placeholder at end -->
      {#if placeholder === list.length}
        <li class="h-2 bg-primary/40 rounded transition-all"></li>
      {/if}
    </ul>
  {/if}
</aside>
