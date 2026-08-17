<script lang="ts">
  /**
   * `/admin/users` - who can sign in, and who can administer.
   *
   * A fourth question alongside the other admin tabs: not identity
   * (`/admin/matching`), not scope (`/admin/sonarr`), not production
   * (`/admin/subtitles`), but *access*.
   *
   * Two things are shown here that are invisible everywhere else, and both earn
   * their column. **`createdAt`**, because signup is open to the internet and a
   * stranger's account otherwise looks exactly like a friend's. And **whether an
   * admin has a verified email**, because an admin without one cannot recover
   * their own account - the backend refuses the open reset for them, by design.
   *
   * Every refusal the backend can give is rendered as its own message rather
   * than a generic failure. `LAST_ADMIN` and `ADMIN_RESET_BLOCKED` are the two
   * that look like bugs if reported vaguely: both are deliberate, and a reader
   * who cannot tell "refused on purpose" from "broke" will go looking for a bug
   * that is not there.
   */
  import { onMount, tick } from 'svelte';
  import { authToken, userName } from '../stores/auth';
  import { apiFetch, QUICK, ApiError } from '../lib/remote';
  import AdminShell from '../components/AdminShell.svelte';

  interface Row {
    id: number;
    username: string;
    email: string | null;
    emailVerified: boolean;
    isAdmin: boolean;
    createdAt: string;
    listCount: number;
    needsEmail: boolean;
  }

  let rows: Row[] = [];
  let mailer: { configured: boolean; describe: string } | null = null;
  let loading = true;
  /** Null means "not yet asked"; an ApiError distinguishes down from refused. */
  let loadError: string | null = null;
  let unreachable = false;

  /** Per-row inline feedback, keyed by user id so one row's error is its own. */
  let notice: Record<number, { kind: 'ok' | 'error'; text: string }> = {};
  let busy: Record<number, boolean> = {};
  let testResult: { ok: boolean; text: string } | null = null;
  let testing = false;

  function auth(): HeadersInit {
    return { Authorization: `Bearer ${$authToken}`, 'Content-Type': 'application/json' };
  }

  async function load() {
    loading = true;
    loadError = null;
    unreachable = false;
    try {
      const res = await apiFetch('/api/admin/users', { headers: auth() }, {
        timeoutMs: QUICK,
        label: 'admin/users',
      });
      const data = await res.json();
      if (!res.ok) {
        loadError = data?.error || `Request failed (${res.status})`;
        return;
      }
      rows = data.users;
      mailer = data.mailer;
    } catch (err) {
      // "Couldn't reach the server" and "the server said no" mean different
      // things on screen - the distinction remote.ts exists to preserve.
      unreachable = err instanceof ApiError ? err.unreachable : true;
      loadError =
        unreachable
          ? 'Cannot reach the server.'
          : (err as Error)?.message || 'Something went wrong.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  /** One place that turns a response into either a reload or a row message. */
  async function mutate(id: number, path: string, init: RequestInit, okText: string) {
    busy = { ...busy, [id]: true };
    notice = { ...notice, [id]: undefined as any };
    try {
      const res = await apiFetch(path, { ...init, headers: auth() }, {
        timeoutMs: QUICK,
        retries: 0, // never retry a write
        label: path,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notice = { ...notice, [id]: { kind: 'error', text: data?.error || `Failed (${res.status})` } };
        return;
      }
      await load();
      notice = { ...notice, [id]: { kind: 'ok', text: okText } };
    } catch (err) {
      notice = {
        ...notice,
        [id]: { kind: 'error', text: 'Could not reach the server. Nothing was changed.' },
      };
    } finally {
      busy = { ...busy, [id]: false };
    }
  }

  function setAdmin(row: Row, isAdmin: boolean) {
    if (!isAdmin && !confirm(`Remove admin access from ${row.username}?`)) return;
    mutate(
      row.id,
      `/api/admin/users/${row.id}`,
      { method: 'PATCH', body: JSON.stringify({ isAdmin }) },
      isAdmin ? `${row.username} is now an admin.` : `${row.username} is no longer an admin.`
    );
  }

  /**
   * Both admin actions CLEAR something; neither sets one.
   *
   * Setting a password would mean relaying it, and would leave the admin knowing
   * it. Clearing hands control straight back to the owner: they set the next one
   * themselves at `/reset-password`, which for an ordinary account needs nothing
   * but their username.
   */
  function clearPassword(row: Row) {
    const after = row.emailVerified
      ? `They will need a code emailed to ${row.email} to set a new one.`
      : `They can set a new one at the reset page using just their username.`;
    if (!confirm(`Clear ${row.username}'s password?\n\n${after}\n\nThey will also be signed out everywhere.`)) return;
    mutate(
      row.id,
      `/api/admin/users/${row.id}/clear-password`,
      { method: 'POST' },
      `Password cleared. ${row.username} sets a new one at the reset page - ` +
        `nothing to send them.`
    );
  }

  /** Opens the Options modal with the Account section already expanded. */
  function openMyAccount() {
    window.dispatchEvent(new CustomEvent('sc:open-account'));
  }

  function clearEmail(row: Row) {
    if (!confirm(
      `Remove ${row.email} from ${row.username}'s account?\n\n` +
      `They will go back to resetting their password with just their username, ` +
      `which is the fix when someone can no longer read that inbox.`
    )) return;
    mutate(
      row.id,
      `/api/admin/users/${row.id}/clear-email`,
      { method: 'POST' },
      `Email removed. ${row.username} can reset with just their username again.`
    );
  }

  function removeUser(row: Row) {
    const what =
      row.listCount > 0
        ? `${row.username} and their ${row.listCount} list ${row.listCount === 1 ? 'entry' : 'entries'}`
        : row.username;
    if (!confirm(`Permanently delete ${what}? This cannot be undone.`)) return;
    mutate(row.id, `/api/admin/users/${row.id}`, { method: 'DELETE' }, `${row.username} deleted.`);
  }

  async function sendTest() {
    testing = true;
    testResult = null;
    try {
      const res = await apiFetch('/api/admin/users/test-email', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      }, { timeoutMs: 30_000, retries: 0, label: 'test-email' });
      const data = await res.json().catch(() => ({}));
      testResult = data?.ok
        ? { ok: true, text: `Sent to ${data.sentTo}. Check that it arrives.` }
        : { ok: false, text: data?.error || 'Send failed.' };
    } catch {
      testResult = { ok: false, text: 'Could not reach the server.' };
    } finally {
      testing = false;
    }
  }

  function shortDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '?' : d.toLocaleDateString();
  }

  $: adminCount = rows.filter((r) => r.isAdmin).length;
  $: adminsMissingEmail = rows.filter((r) => r.needsEmail);
  $: protectedCount = rows.filter((r) => r.emailVerified).length;
  /**
   * Signups in the last 30 days. Worth a tile precisely because signup is open
   * to the internet: a stranger arriving is the one thing on this page nobody
   * would otherwise go looking for.
   */
  $: recentCount = rows.filter(
    (r) => Date.now() - new Date(r.createdAt).getTime() < 30 * 24 * 60 * 60 * 1000
  ).length;

  // --- Filtering and sorting -------------------------------------------------
  // Signup is open to the internet, so this list only grows, and it is mostly
  // people you are not looking for. Both counts are always shown when a filter
  // is active: "3 of 47" tells you the other 44 exist, where a bare list of 3
  // silently looks like the whole site.
  type SortKey = 'username' | 'email' | 'createdAt' | 'listCount' | 'isAdmin';
  let search = '';
  let sortKey: SortKey = 'username';
  let sortDir: 1 | -1 = 1;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === 1 ? -1 : 1;
    } else {
      sortKey = key;
      // Counts and dates are most useful largest-first; names A-Z.
      sortDir = key === 'listCount' || key === 'createdAt' || key === 'isAdmin' ? -1 : 1;
    }
  }

  function compare(a: Row, b: Row): number {
    switch (sortKey) {
      case 'listCount':
        return a.listCount - b.listCount;
      case 'createdAt':
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      case 'isAdmin':
        return Number(a.isAdmin) - Number(b.isAdmin);
      case 'email':
        // Accounts with no address sort last either way - an empty string would
        // otherwise pile them at the top, which is never what you are looking for.
        if (!a.email !== !b.email) return a.email ? -1 : 1;
        return (a.email ?? '').localeCompare(b.email ?? '');
      default:
        return a.username.localeCompare(b.username);
    }
  }

  $: needle = search.trim().toLowerCase();
  $: visible = rows
    .filter(
      (r) =>
        !needle ||
        r.username.toLowerCase().includes(needle) ||
        (r.email ?? '').toLowerCase().includes(needle)
    )
    .slice()
    .sort((a, b) => compare(a, b) * sortDir);

  /**
   * Header arrow for the active column, as an HTML entity.
   *
   * Entities rather than the glyphs themselves so this file stays ASCII - the
   * repo convention, and the reason is that a stray non-ASCII character here is
   * invisible next to a lookalike and breaks tooling on this machine.
   *
   * **Reactive assignment, not a plain function**, and that is load-bearing.
   * Svelte tracks the variables named in a template expression, not the ones a
   * called function happens to read - so `function arrow(key)` was never
   * re-evaluated when `sortKey` changed, and the arrow stayed pinned to the
   * column it started on while the sort itself moved. `tsc`, the build and
   * svelte-check were all clean; it was only visible on screen.
   */
  $: arrow = (key: SortKey): string =>
    sortKey !== key ? '' : sortDir === 1 ? ' &uarr;' : ' &darr;';
</script>

<AdminShell current="users">
<!-- The shell is deliberately one width for every admin tab, so a page that
     wants narrower content constrains its own children - the same thing the
     Connection form does. Left unconstrained, this table stretched to 100rem
     with vast gaps between columns and the stat tiles became 380px of empty
     space around a two-digit number. -->
<div class="flex flex-col gap-4 max-w-6xl">
  <!-- Mail status first: every recovery path on this page depends on it, and
       "why did nothing arrive" is the question this line answers up front.
       It is labelled as the SERVER's sending account rather than just "Email",
       because it sits directly above a table of user email addresses and was
       read as belonging to one of them. -->
  <div class="card bg-base-200">
    <div class="card-body p-4 gap-2">
      <div class="flex flex-wrap items-center gap-3">
        <span class="font-semibold">Outgoing mail</span>
        {#if mailer?.configured}
          <span class="badge badge-success badge-sm">configured</span>
        {:else if mailer}
          <span class="badge badge-warning badge-sm">not configured</span>
        {/if}
        <button
          class="btn btn-xs btn-outline ml-auto"
          title="Sends a test message to the email address on your own account"
          on:click={sendTest}
          disabled={testing || !mailer?.configured}
        >
          {testing ? 'Sending...' : 'Send test email'}
        </button>
      </div>

      {#if mailer?.configured}
        <p class="text-sm text-base-content/70">
          Codes are sent from <span class="font-mono">{mailer.describe}</span> -
          the server's own account, not a user's.
        </p>
      {:else if mailer}
        <p class="text-sm text-base-content/70">
          No sending account, so codes can't be emailed. Set
          <code>SMTP_HOST</code>, <code>SMTP_USER</code> and
          <code>SMTP_PASS</code> on the server.
        </p>
      {/if}

      {#if testResult}
        <div class="text-sm" class:text-success={testResult.ok} class:text-error={!testResult.ok}>
          {testResult.text}
        </div>
      {/if}
    </div>
  </div>

  {#if adminsMissingEmail.length}
    <div class="alert alert-warning">
      <span>
        {adminsMissingEmail.length === 1 ? 'An admin has' : `${adminsMissingEmail.length} admins have`}
        no verified email address
        ({adminsMissingEmail.map((r) => r.username).join(', ')}).
        Until that is set in Options &rarr; Account, the account cannot be
        recovered if its password is lost - password reset is deliberately closed
        to admin accounts.
      </span>
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center gap-2 text-sm opacity-70">
      <span class="loading loading-spinner loading-sm"></span> Loading accounts...
    </div>
  {:else if loadError}
    <div class="alert alert-error flex-wrap">
      <span>{loadError}</span>
      <button class="btn btn-sm" on:click={load}>Retry</button>
    </div>
  {:else}
    <!-- Tiles then a titled table, matching the other admin tabs. -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <div class="stat bg-base-200 rounded-box p-3">
        <div class="stat-title text-xs">Accounts</div>
        <div class="stat-value text-3xl">{rows.length}</div>
        <div class="stat-desc text-xs">anyone can sign up</div>
      </div>
      <div class="stat bg-base-200 rounded-box p-3">
        <div class="stat-title text-xs">Admins</div>
        <div class="stat-value text-3xl">{adminCount}</div>
        <div class="stat-desc text-xs">the last one can't be removed</div>
      </div>
      <div class="stat bg-base-200 rounded-box p-3">
        <div class="stat-title text-xs">Reset by code</div>
        <div class="stat-value text-3xl">{protectedCount}</div>
        <div class="stat-desc text-xs">have a verified email</div>
      </div>
      <div class="stat bg-base-200 rounded-box p-3">
        <div class="stat-title text-xs">Joined, 30 days</div>
        <div class="stat-value text-3xl">{recentCount}</div>
        <div class="stat-desc text-xs">{recentCount ? 'check you know them' : 'nobody new'}</div>
      </div>
    </div>

    <div>
      <h2 class="text-lg font-semibold mb-1">Accounts</h2>
      <p class="text-sm opacity-70 mb-3">
        Admins are equal. The last admin can't be removed, and promoting someone
        needs a verified email on their account.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <input
          class="input input-bordered input-sm w-full max-w-xs"
          type="search"
          placeholder="Filter by username or email"
          bind:value={search}
        />
        {#if needle}
          <span class="text-sm opacity-70">{visible.length} of {rows.length} shown</span>
        {/if}
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr>
            <th aria-sort={sortKey === 'username' ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}>
              <button class="link no-underline hover:underline" on:click={() => toggleSort('username')}>
                User{@html arrow('username')}
              </button>
            </th>
            <th aria-sort={sortKey === 'email' ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}>
              <button class="link no-underline hover:underline" on:click={() => toggleSort('email')}>
                Email{@html arrow('email')}
              </button>
            </th>
            <th aria-sort={sortKey === 'createdAt' ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}>
              <button class="link no-underline hover:underline" on:click={() => toggleSort('createdAt')}>
                Joined{@html arrow('createdAt')}
              </button>
            </th>
            <th class="text-right" aria-sort={sortKey === 'listCount' ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}>
              <button class="link no-underline hover:underline" on:click={() => toggleSort('listCount')}>
                Lists{@html arrow('listCount')}
              </button>
            </th>
            <!-- One column per action. They were crammed into a single "Actions"
                 cell, which wrapped into three lines and squeezed every other
                 column narrow. -->
            <th aria-sort={sortKey === 'isAdmin' ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}>
              <button class="link no-underline hover:underline" on:click={() => toggleSort('isAdmin')}>
                Admin{@html arrow('isAdmin')}
              </button>
            </th>
            <!-- "Clear password" / "Clear email", not "Password" / "Email": the
                 data column is already called Email, and two identical headers
                 meaning different things is worse than two long ones. -->
            <th class="whitespace-nowrap">Clear password</th>
            <th class="whitespace-nowrap">Clear email</th>
            <th>Delete</th>
          </tr>
        </thead>
        <tbody>
          {#if !visible.length}
            <tr>
              <td colspan="8" class="text-sm opacity-70">
                No account matches "{search}".
              </td>
            </tr>
          {/if}
          {#each visible as row (row.id)}
            <tr class:opacity-60={busy[row.id]}>
              <td>
                <div class="flex items-center gap-2">
                  <span class="font-medium">{row.username}</span>
                  {#if row.isAdmin}
                    <span class="badge badge-primary badge-sm">admin</span>
                  {/if}
                </div>
                {#if notice[row.id]}
                  <div
                    class="text-xs mt-1 whitespace-pre-wrap"
                    class:text-success={notice[row.id].kind === 'ok'}
                    class:text-error={notice[row.id].kind === 'error'}
                  >
                    {notice[row.id].text}
                  </div>
                {/if}
              </td>
              <td class="text-sm">
                {#if row.email}
                  <span class="opacity-80">{row.email}</span>
                  {#if row.emailVerified}
                    <span class="badge badge-success badge-xs ml-1">verified</span>
                  {:else}
                    <span class="badge badge-ghost badge-xs ml-1" title="Set but never confirmed, so it protects nothing yet">
                      unverified
                    </span>
                  {/if}
                {:else if row.needsEmail}
                  <span class="text-warning">none - cannot recover</span>
                {:else}
                  <span class="opacity-50">none</span>
                {/if}
              </td>
              <td class="text-sm opacity-70 whitespace-nowrap">{shortDate(row.createdAt)}</td>
              <td class="text-sm opacity-70 text-right">{row.listCount}</td>
              <td class="whitespace-nowrap">
                {#if row.isAdmin}
                  <button
                    class="btn btn-xs btn-outline"
                    disabled={busy[row.id] || adminCount <= 1}
                    title={adminCount <= 1
                      ? 'The only admin cannot be demoted - promote someone else first'
                      : 'Remove admin access'}
                    on:click={() => setAdmin(row, false)}
                  >
                    Remove
                  </button>
                {:else}
                  <button
                    class="btn btn-xs btn-outline"
                    disabled={busy[row.id] || !row.emailVerified}
                    title={row.emailVerified
                      ? 'Make this account an admin'
                      : 'Needs a verified email address first - an admin who cannot receive a code cannot recover their account'}
                    on:click={() => setAdmin(row, true)}
                  >
                    Make admin
                  </button>
                {/if}
              </td>

              {#if row.username === $userName}
                <!-- Your own row. Everything you could want here - change your
                     password, set or verify your email - already exists in
                     Options, and it asks for your current password, which these
                     clear buttons deliberately do not. Sending you there beats a
                     second implementation and beats two greyed-out buttons. -->
                <td colspan="2" class="whitespace-nowrap">
                  <button
                    class="btn btn-xs btn-outline"
                    title="Your own account: change your password or manage your email in Options"
                    on:click={openMyAccount}
                  >
                    Manage my account
                  </button>
                </td>
              {:else}
                <td class="whitespace-nowrap">
                  <button
                    class="btn btn-xs btn-outline"
                    disabled={busy[row.id] || (row.isAdmin && !row.emailVerified)}
                    title={row.isAdmin && !row.emailVerified
                      ? 'They are an admin with no verified email, so clearing it would leave no way back in. Remove their admin access first.'
                      : 'Clear their password so they can set a new one themselves'}
                    on:click={() => clearPassword(row)}
                  >
                    Clear
                  </button>
                </td>
                <td class="whitespace-nowrap">
                  <button
                    class="btn btn-xs btn-outline"
                    disabled={busy[row.id] || !row.email || row.isAdmin}
                    title={!row.email
                      ? 'No email on this account'
                      : row.isAdmin
                        ? 'An admin with no email cannot recover their account. Remove their admin access first.'
                        : 'Remove their email so they can reset with just their username - the fix when someone loses that inbox'}
                    on:click={() => clearEmail(row)}
                  >
                    Clear
                  </button>
                </td>
              {/if}

              <td class="whitespace-nowrap">
                <button
                  class="btn btn-xs btn-outline btn-error"
                  disabled={busy[row.id] || row.username === $userName || (row.isAdmin && adminCount <= 1)}
                  title={row.username === $userName
                    ? 'You cannot delete the account you are signed in as'
                    : row.isAdmin && adminCount <= 1
                      ? 'The only admin cannot be deleted - promote someone else first'
                      : `Permanently delete ${row.username} and their list`}
                  on:click={() => removeUser(row)}
                >
                  Delete
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

  {/if}
</div>
</AdminShell>
