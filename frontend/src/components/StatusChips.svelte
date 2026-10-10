<script lang="ts">
  /**
   * The filter row both admin pages share: Needs attention, each level, All.
   * Counts sit in the buttons so the totals are visible before anything is
   * clicked - a filter that hides how much it hides is the failure the pages
   * were redesigned to remove.
   */
  import { createEventDispatcher } from 'svelte';
  import { LEVEL, LEVELS, type Chip } from '../lib/entryStatus';

  export let value: Chip;
  export let counts: Record<Chip, number>;
  /** What the "all" chip is called on this page. */
  export let allLabel = 'All';

  const dispatch = createEventDispatcher<{ change: Chip }>();

  const chips: Chip[] = ['attention', ...LEVELS, 'all'];
  const labelOf = (c: Chip) => (c === 'attention' ? 'Needs attention' : c === 'all' ? allLabel : LEVEL[c].label);

  function pick(c: Chip) {
    value = c;
    dispatch('change', c);
  }
</script>

<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status" data-chips>
  {#each chips as c (c)}
    <button
      type="button"
      class="btn btn-xs normal-case gap-1"
      class:btn-neutral={value === c}
      class:btn-outline={value !== c}
      aria-pressed={value === c}
      data-chip={c}
      on:click={() => pick(c)}
    >
      {#if c !== 'attention' && c !== 'all'}
        <span class="badge badge-xs {LEVEL[c].badge}" aria-hidden="true"></span>
      {/if}
      {labelOf(c)}
      <span class="opacity-60 tabular-nums">{counts[c] ?? 0}</span>
    </button>
  {/each}
  <slot />
</div>
