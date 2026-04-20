<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  // --- Props ---
  export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  export let season: Season;
  export let year: number;
  export let hideSequels: boolean = false;
  export let hideInList: boolean = false;
  export let showListToggle: boolean = true;
  export let showSequelToggle: boolean = true;
  // Toggle to hide adult (18+) content
  export let hideAdult: boolean = false;
  export let showAdultToggle: boolean = false;
  // Search query for filtering in parent
  export let searchQuery: string = '';
  // Show search box (binds to searchQuery)
  export let showSearch: boolean = false;
  // "Catch up on another user's ratings" filter
  export let showCatchUpToggle: boolean = false;
  export let catchUpMode: boolean = false;
  export let catchUpUser: string | null = null;
  export let availableCatchUpUsers: string[] = [];

  // --- Constants ---
  const SEASONS: Array<{ value: Season; label: string }> = [
    { value: 'WINTER', label: 'Winter' },
    { value: 'SPRING', label: 'Spring' },
    { value: 'SUMMER', label: 'Summer' },
    { value: 'FALL', label: 'Fall' }
  ];

  const currentYear: number = new Date().getFullYear();
  // Provide a selectable range of years (current ±10 years)
  const years: number[] = Array.from({ length: 21 }, (_, i) => currentYear - 10 + i);

  const dispatch = createEventDispatcher();

  function selectSeason(s: Season) {
    if (season !== s) {
      season = s;
      dispatch('change');
    }
  }

  function updateYear(event: Event) {
    const newVal = Number((event.target as HTMLSelectElement).value);
    if (!Number.isNaN(newVal) && year !== newVal) {
      year = newVal;
      dispatch('change');
    }
  }

  // No extra toggle functions; bind:checked updates props automatically.

  // Catch-up dropdown state
  $: catchUpSelectValue = catchUpMode && catchUpUser ? catchUpUser : '';
  $: catchUpTooltip = availableCatchUpUsers.length === 0
    ? 'No other users have rated trailers this season'
    : "Show only trailers the selected user has in their list that you don't";

  function onCatchUpChange(e: Event) {
    const target = e.currentTarget as HTMLSelectElement;
    const v = target.value;
    if (v) {
      catchUpUser = v;
      catchUpMode = true;
    } else {
      catchUpMode = false;
    }
    dispatch('change');
  }
</script>

  <!-- Responsive layout: 1 col (<1122px), 2 cols (>=1122px), 3 cols (>=1732px) -->
  <div class="grid w-full mb-6 gap-4 relative z-10 \
    grid-cols-1 2cols:grid-cols-[auto,1fr] 3cols:grid-cols-[auto,1fr,auto] items-center">
  <!-- Left controls: season buttons + year dropdown (wraps on narrow viewports only) -->
  <div class="flex flex-wrap sm:flex-nowrap gap-x-4 gap-y-2 items-center">
    <!-- Season buttons -->
    <div class="flex gap-2">
      {#each SEASONS as { value, label }}
        <button
          type="button"
          class={`btn btn-sm ${season === value ? 'btn-primary' : 'btn-ghost'}`}
          on:click={() => selectSeason(value)}
        >
          {label}
        </button>
      {/each}
    </div>

    <!-- Year dropdown -->
    <select
      class="select select-bordered w-24 sm:w-28 pl-2 pr-8 sm:px-4"
      bind:value={year}
      on:change={updateYear}
    >
      {#each years as y}
        <option value={y}>{y}</option>
      {/each}
    </select>
  </div>
  {#if showSearch}
    <!-- Centered search box -->
    <div class="flex-1 flex items-center gap-2">
      <label for="search" class="font-medium mr-2">Search series:</label>
      <input
        id="search"
        type="text"
        bind:value={searchQuery}
        class="input flex-1"
      />
    </div>
  {/if}

  {#if showAdultToggle || showSequelToggle || showListToggle || showCatchUpToggle}
  <!-- Right-aligned toggles; span both columns on 2cols -->
  <div class="flex items-center gap-6 text-sm 2cols:col-span-2 3cols:col-span-1">
    {#if showAdultToggle}
      <label class="flex items-center gap-2 select-none cursor-pointer" class:opacity-50={catchUpMode}>
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={hideAdult}
          disabled={catchUpMode}
          on:change={() => dispatch('change')}
        />
        Hide 18+
      </label>
    {/if}
    {#if showSequelToggle}
      <label class="flex items-center gap-2 select-none cursor-pointer" class:opacity-50={catchUpMode}>
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={hideSequels}
          disabled={catchUpMode}
          on:change={() => dispatch('change')}
        />
        Hide sequels
      </label>
    {/if}

    {#if showListToggle}
      <label class="flex items-center gap-2 select-none cursor-pointer" class:opacity-50={catchUpMode}>
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={hideInList}
          disabled={catchUpMode}
          on:change={() => dispatch('change')}
        />
        Hide in My List
      </label>
    {/if}

    {#if showCatchUpToggle}
      <label class="flex items-center gap-2" title={catchUpTooltip}>
        <span class="select-none">Catch up on:</span>
        <select
          class="select select-bordered select-sm"
          value={catchUpSelectValue}
          disabled={availableCatchUpUsers.length === 0}
          on:change={onCatchUpChange}
        >
          {#if availableCatchUpUsers.length === 0}
            <option value="">No users to catch up on</option>
          {:else}
            <option value="">Off</option>
            {#each availableCatchUpUsers as u}
              <option value={u}>{u}</option>
            {/each}
          {/if}
        </select>
      </label>
    {/if}
  </div>
  {/if}
</div>
