<script lang="ts">
  import { onMount } from 'svelte';
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
   *
   * It also owns two account-level states, because both must appear on whichever
   * admin page you happen to open rather than only on the one that caused them:
   * the **first-run claim** (no admin exists at all) and the **nag** (you are an
   * admin with no verified email, so you have no way back into your own account).
   */
  export let current: 'connection' | 'matching' | 'sonarr' | 'subtitles' | 'users';

  /**
   * `$isAdmin !== false` and not `=== true`: the store is tri-state, and
   * `undefined` means "we have not been told yet". Treating not-yet-known as
   * not-admin flashes the warning on every load for the one person who is.
   */
  $: allowed = !!$authToken && $isAdmin !== false;

  interface Account {
    username: string;
    emailVerified: boolean;
    isAdmin: boolean;
    needsEmail: boolean;
    setupNeeded: boolean;
  }

  let account: Account | null = null;
  let setupCode = '';
  let claiming = false;
  let claimError = '';

  async function loadAccount() {
    if (!$authToken) return;
    try {
      const res = await fetch('/api/auth/account', {
        headers: { Authorization: `Bearer ${$authToken}` },
      });
      if (res.ok) account = await res.json();
    } catch {
      // Non-fatal. The gate below still works off the jellyfin status store, so
      // a failed probe costs the banner, not the page.
    }
  }

  onMount(loadAccount);

  async function claimAdmin() {
    claimError = '';
    if (!setupCode.trim()) {
      claimError = 'Enter the setup code from the server log.';
      return;
    }
    claiming = true;
    try {
      const res = await fetch('/api/auth/claim-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify({ code: setupCode.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        claimError = data.error || 'That did not work.';
        return;
      }
      // Full reload rather than a store poke: the admin flag rides on
      // /api/jellyfin/status, which is fetched once per login, and every admin
      // page reads it. Re-deriving that by hand here would be a second source
      // of truth for who is an admin.
      window.location.reload();
    } catch {
      claimError = 'Could not reach the server.';
    } finally {
      claiming = false;
    }
  }
</script>

<main class="max-w-[100rem] mx-auto px-4 flex flex-col gap-4">
  <h1 class="text-2xl font-bold">Admin</h1>

  {#if $authToken && account?.setupNeeded}
    <!-- Shown ahead of the gate on purpose: nobody is an admin yet, so the gate
         would refuse the very person who is supposed to claim it. -->
    <div class="card bg-base-200 max-w-2xl">
      <div class="card-body gap-3">
        <h2 class="card-title text-lg">Claim admin access</h2>
        <p class="text-sm">
          This server has no admin account yet. The backend printed a one-time
          setup code to its log when it started - find it with
          <code class="text-xs">docker logs saltychart-backend</code>, or in the
          terminal running the dev server, on a line beginning
          <code class="text-xs">[SETUP]</code>.
        </p>
        <p class="text-sm opacity-70">
          Requiring the log is deliberate: it means the first admin is whoever
          can read the server, not whoever signs up first.
        </p>
        <div class="flex gap-2">
          <input
            class="input input-bordered flex-1"
            placeholder="Setup code"
            bind:value={setupCode}
            disabled={claiming}
          />
          <button class="btn btn-primary" on:click={claimAdmin} disabled={claiming}>
            {claiming ? 'Claiming...' : 'Claim'}
          </button>
        </div>
        {#if claimError}
          <div class="text-error text-sm">{claimError}</div>
        {/if}
      </div>
    </div>
  {:else if allowed}
    {#if account?.needsEmail}
      <div class="alert alert-warning">
        <span>
          Your admin account has no verified email address. Admin passwords
          cannot be reset from the login page, so until you add one in
          Options &rarr; Account there is no way back into this account if you
          lose the password.
        </span>
      </div>
    {/if}
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
