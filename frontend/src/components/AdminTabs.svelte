<script lang="ts">
  /**
   * Tab strip shared by the admin pages.
   *
   * Navigation goes through `history.pushState` + a `popstate` event because
   * that is what `App.svelte`'s router listens to — a plain `<a href>` would
   * full-page reload and drop the lazily-loaded chunk cache.
   */
  export let current: 'connection' | 'matching';

  const TABS: { key: 'connection' | 'matching'; label: string; path: string }[] = [
    { key: 'connection', label: 'Connection', path: '/admin' },
    { key: 'matching', label: 'Matching', path: '/admin/matching' },
  ];

  function go(path: string) {
    if (window.location.pathname === path) return;
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
</script>

<div role="tablist" class="tabs tabs-bordered mb-4">
  {#each TABS as t}
    <button
      role="tab"
      class="tab"
      class:tab-active={current === t.key}
      aria-selected={current === t.key}
      on:click={() => go(t.path)}
    >
      {t.label}
    </button>
  {/each}
</div>
