<script lang="ts">
  import { authToken } from '../stores/auth';
  import { isAdmin } from '../stores/jellyfin';
  import AdminTabs from './AdminTabs.svelte';

  /**
   * The frame every admin page sits in: one `<main>`, one `<h1>`, one tab strip,
   * one admin gate.
   *
   * It exists because the three pages had drifted into three different shells -
   * `max-w-2xl`, `max-w-[100rem]` and `w-full sm:w-3/4` - with the Sonarr page
   * additionally using a bare `<div>`, no heading, and **no admin gate at all**,
   * so a non-admin got a load error where the other two say plainly that the
   * page is admin-only. Tabbing between them resized the content and dropped the
   * title, which read as three separate areas of the app rather than one. The
   * tab strip was already shared; the frame around it was not, and that was the
   * whole difference.
   *
   * **The frame is the same width on every page**, deliberately, and a page that
   * wants narrow content constrains its own children instead (the Connection
   * form caps its cards at `max-w-2xl`). An earlier version made width a prop,
   * which put the heading and tabs in a different place on each tab - which is
   * the thing being complained about, just moved up a level.
   */
  export let current: 'connection' | 'matching' | 'sonarr';

  /**
   * `$isAdmin !== false` and not `=== true`: the store is tri-state, and
   * `undefined` means "we have not been told yet". Treating not-yet-known as
   * not-admin flashes the warning on every load for the one person who is.
   */
  $: allowed = !!$authToken && $isAdmin !== false;
</script>

<main class="max-w-[100rem] mx-auto px-4 flex flex-col gap-4">
  <h1 class="text-2xl font-bold">Admin</h1>
  {#if allowed}
    <!-- Tabs inside the gate: a logged-out stranger was once shown the
         "admin only" notice with working Connection / Matching tabs above it,
         which is a confusing half-gate. They leaked nothing, but they
         navigated. -->
    <AdminTabs {current} />
    <slot />
  {:else}
    <div class="alert alert-warning">
      <span>This page is only available to the site admin.</span>
    </div>
  {/if}
</main>
