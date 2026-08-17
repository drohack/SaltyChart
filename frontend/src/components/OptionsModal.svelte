<script lang="ts">
  import { options } from '../stores/options';
  import type { Theme, TitleLanguage } from '../stores/options';
  import { authToken } from '../stores/auth';
  import { seasonYear, type Season } from '../stores/season';
  import { createEventDispatcher, onDestroy, tick } from 'svelte';

  const SEASONS: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

  const themeOptions: { value: Theme; label: string }[] = [
    { value: 'LIGHT', label: 'Light' },
    { value: 'NIGHT', label: 'Night' },
    { value: 'SYSTEM', label: 'System' },
    { value: 'HIGH_CONTRAST', label: 'High Contrast' }
  ];

  const titleLangOptions: { value: TitleLanguage; label: string }[] = [
    { value: 'ENGLISH', label: 'English' },
    { value: 'ROMAJI', label: 'Romaji' },
    { value: 'NATIVE', label: 'Native' }
  ];

  export let open: boolean = false;

  const dispatch = createEventDispatcher();

  function close() {
    open = false;
    dispatch('close');
  }

  /** Close on Escape key even if focus is inside the dialog */
  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  // Ensure global listener is removed if the component unmounts while open
  $: {
    if (open) {
      window.addEventListener('keydown', handleKey);
    } else {
      window.removeEventListener('keydown', handleKey);
    }
  }

  // Set by the Account link on /admin/users, which fires this just before
  // App.svelte opens the modal. Listening here rather than on `svelte:window`
  // because a custom event name is not in Svelte's window event types.
  const onOpenAccount = () => (accountRequested = true);
  window.addEventListener('sc:open-account', onOpenAccount);

  onDestroy(() => {
    window.removeEventListener('keydown', handleKey);
    window.removeEventListener('sc:open-account', onOpenAccount);
  });

  // -- Batch translation (admin only) ---------------------------------
  let batchRunning = false;
  let batchMessage = '';
  let batchIsAdmin: boolean | null = null; // null = not checked yet
  let batchSeason: Season = $seasonYear.season;
  let batchYear: number = $seasonYear.year;

  async function checkBatchStatus() {
    if (!$authToken) return;
    try {
      const res = await fetch('/api/translate/batch/status', {
        headers: { Authorization: `Bearer ${$authToken}` },
      });
      if (res.status === 403) {
        batchIsAdmin = false;
        return;
      }
      batchIsAdmin = true;
      const data = await res.json();
      batchRunning = data.running;
      if (data.running) {
        batchMessage = `Running since ${new Date(data.startedAt).toLocaleTimeString()}`;
      }
    } catch {}
  }

  // Check admin status and sync season when modal first opens
  let lastOpenState = false;
  $: if (open && !lastOpenState) {
    lastOpenState = true;
    batchSeason = $seasonYear.season;
    batchYear = $seasonYear.year;
    if ($authToken && batchIsAdmin === null) {
      checkBatchStatus();
    }
    if ($authToken) loadAccount();
    // Arriving via the Account link on /admin/users - open straight to it, or
    // the trip lands you on a preferences form with no sign of what you came
    // for. Consumed on read so a later manual open is not forced open too.
    if (accountRequested) {
      accountOpen = true;
      accountRequested = false;
    }
  }
  $: if (!open) {
    lastOpenState = false;
  }

  async function startBatch(dryRun = false) {
    if (!$authToken) return;
    batchMessage = dryRun ? 'Checking trailers...' : 'Starting batch...';
    batchRunning = true;
    try {
      const res = await fetch('/api/translate/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${$authToken}`,
        },
        body: JSON.stringify({ dryRun, season: batchSeason, year: batchYear }),
      });
      const data = await res.json();
      if (data.error) {
        batchMessage = data.error;
        batchRunning = false;
      } else {
        batchMessage = dryRun ? 'Fetching anime list...' : 'Batch started, fetching anime list...';
        // Poll quickly - dry runs finish in seconds
        pollBatchStatus();
      }
    } catch (e) {
      batchMessage = 'Failed to start batch';
      batchRunning = false;
    }
  }

  async function pollBatchStatus() {
    if (!$authToken) return;
    try {
      const res = await fetch('/api/translate/batch/status', {
        headers: { Authorization: `Bearer ${$authToken}` },
      });
      const data = await res.json();
      batchRunning = data.running;
      const logLines: string[] = data.log || [];
      if (data.running) {
        const meaningful = [...logLines].reverse().find((l: string) => l.trim() && !l.startsWith('  [SKIP]'));
        batchMessage = meaningful || 'Running...';
        setTimeout(pollBatchStatus, 1500);
      } else if (logLines.length > 0) {
        // Build a useful completion summary
        const needsLine = logLines.find((l: string) => l.includes('trailers need translation'));
        const completeLine = logLines.find((l: string) => l.includes('Complete:'));
        const nothingLine = logLines.find((l: string) => l.includes('Nothing to translate') || l.includes('already cached. Done'));
        const isDryRun = logLines.some((l: string) => l.includes('DRY RUN'));

        if (isDryRun) {
          const trailerLines = logLines.filter((l: string) => /^\s{2}\S/.test(l) && !l.startsWith('  [SKIP]'));
          batchMessage = needsLine
            ? `${needsLine.trim()} (${trailerLines.length} to translate)`
            : `Dry run complete: ${trailerLines.length} trailers`;
        } else {
          batchMessage = completeLine?.trim() || nothingLine?.trim() || 'Done';
        }
      } else {
        batchMessage = 'Done';
      }
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Account: the recovery address, and changing your password.
  //
  // The address is what decides how this account can be reset. Setting one is
  // therefore opting IN to protection - and it only counts once a code sent to
  // it comes back, because an unverified address would make a typo permanent:
  // the account would be locked onto a coded path with no reachable inbox.
  // -------------------------------------------------------------------------
  let account: {
    username: string;
    email: string | null;
    emailVerified: boolean;
    isAdmin: boolean;
    needsEmail: boolean;
    pendingEmail: string | null;
  } | null = null;

  let emailInput = '';
  let emailPassword = '';
  let emailCode = '';
  let emailHint = '';
  let awaitingCode = false;
  let accountBusy = false;
  let accountMessage = '';
  let accountError = '';
  let codeInput: HTMLInputElement;
  /**
   * The section is collapsed by default - it is long, and most visits here are
   * for theme or title language. It opens itself whenever there is something to
   * DO: an admin with no address, or a code waiting to be entered. Hiding either
   * behind a closed summary would bury the one thing the user came back for.
   */
  let accountOpen = false;
  /** Set by the `sc:open-account` event before this modal is told to open. */
  let accountRequested = false;

  let currentPassword = '';
  let nextPassword = '';
  let confirmPassword = '';
  let passwordMessage = '';
  let passwordError = '';

  async function loadAccount() {
    if (!$authToken) return;
    try {
      const res = await fetch('/api/auth/account', {
        headers: { Authorization: `Bearer ${$authToken}` },
      });
      if (res.ok) {
        account = await res.json();
        emailInput = account?.email ?? '';
        // The server reports an outstanding change (an unconsumed, unexpired
        // verifyEmail code) so reopening the modal lands on the code box rather
        // than silently forgetting a half-finished verification. That is exactly
        // the state someone reaches by closing the modal mid-verify, which is
        // easy to do and used to leave no trace a step was owed.
        awaitingCode = !!account?.pendingEmail;
        if (account?.pendingEmail) emailHint = account.pendingEmail;
        accountOpen = accountOpen || awaitingCode || !!account?.needsEmail;
      }
    } catch {
      // Non-fatal: the rest of the modal is preferences and works offline.
    }
  }

  async function saveEmail() {
    accountError = '';
    accountMessage = '';
    if (!emailInput.trim() || !emailPassword) {
      accountError = 'Enter your address and your current password.';
      return;
    }
    accountBusy = true;
    // Said BEFORE the request, not after. Sending goes through a real SMTP
    // conversation and takes seconds; without this the fields simply grey out
    // and the modal looks frozen or broken. Reported from actual use - someone
    // closed the modal and reopened it because nothing indicated a step was
    // in progress, or that a verification step existed at all.
    accountMessage = `Sending a code to ${emailInput.trim()}...`;
    try {
      const res = await fetch('/api/auth/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify({ email: emailInput.trim(), currentPassword: emailPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        accountMessage = '';
        accountError = data.error || 'Could not save that address.';
        return;
      }
      emailHint = data.hint || emailInput.trim();
      emailPassword = '';
      awaitingCode = true;
      accountMessage = `Code sent to ${emailHint}. Enter it below to finish - the address does nothing until you do.`;
      await loadAccount();
      // Put the cursor where the next action is. The box appearing after a
      // multi-second wait is easy to miss entirely.
      await tick();
      codeInput?.focus();
    } catch {
      accountMessage = '';
      accountError = 'Could not reach the server.';
    } finally {
      accountBusy = false;
    }
  }

  async function verifyEmail() {
    accountError = '';
    accountMessage = '';
    if (!emailCode.trim()) {
      accountError = 'Enter the code from your email.';
      return;
    }
    accountBusy = true;
    try {
      const res = await fetch('/api/auth/email/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify({ code: emailCode.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        accountError = data.error || 'That code did not work.';
        return;
      }
      emailCode = '';
      awaitingCode = false;
      accountMessage = 'Address verified. Password resets now need a code.';
      await loadAccount();
    } catch {
      accountError = 'Could not reach the server.';
    } finally {
      accountBusy = false;
    }
  }

  async function changePassword() {
    passwordError = '';
    passwordMessage = '';
    if (!currentPassword || !nextPassword) {
      passwordError = 'Enter your current and new password.';
      return;
    }
    // A typo here signs you out of every other device and leaves a password you
    // never meant to set - and an admin with no verified email has no way to
    // undo that. The server checks it too.
    if (nextPassword !== confirmPassword) {
      passwordError = 'The two new passwords do not match.';
      return;
    }
    accountBusy = true;
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify({
          currentPassword,
          newPassword: nextPassword,
          confirmPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        passwordError = data.error || 'Could not change the password.';
        return;
      }
      // The server rotates the token version, so every OTHER session is now
      // dead. It hands back a fresh token so this one keeps working - which is
      // the point of changing a password you think someone else knows.
      if (data.token) authToken.set(data.token);
      currentPassword = '';
      nextPassword = '';
      confirmPassword = '';
      passwordMessage = 'Password changed. Other devices have been signed out.';
    } catch {
      passwordError = 'Could not reach the server.';
    } finally {
      accountBusy = false;
    }
  }
</script>

{#if open}
  <!-- Modal overlay: covers the viewport and dims background without disabling page scroll -->
  <div class="fixed inset-0 z-50 flex items-center justify-center pointer-events-auto">
    <!-- Backdrop (button so click/Enter/Escape all close the dialog) -->
    <button
      type="button"
      class="absolute inset-0 bg-black/50 cursor-default"
      aria-label="Close dialog"
      on:click={close}
    ></button>

    <!-- Dialog box. stop-propagation is a correctness concern (prevents backdrop-click close when
         user clicks inside the modal); role="dialog" is the correct ARIA role but Svelte's a11y
         checker doesn't treat it as interactive, hence the ignore. -->
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div
      class="modal-box relative z-10"
      role="dialog"
      aria-modal="true"
      on:click|stopPropagation
      on:keydown|stopPropagation
    >
      <h3 class="font-bold text-lg mb-4">Options</h3>

      <!-- Theme selection -->
      <div class="form-control mb-4">
        <label class="label" for="themeSelect"><span class="label-text">Theme</span></label>
        <select
          id="themeSelect"
          class="select select-bordered"
          bind:value={$options.theme}
        >
          {#each themeOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>

      <!-- Title language selection -->
      <div class="form-control mb-4">
        <label class="label" for="titleLangSelect"><span class="label-text">Title Language</span></label>
        <select
          id="titleLangSelect"
          class="select select-bordered"
          bind:value={$options.titleLanguage}
        >
          {#each titleLangOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>

      <!-- Toggles -->
      <div class="form-control mb-4">
        <label class="label cursor-pointer">
          <span class="label-text">Video Autoplay</span>
          <input type="checkbox" class="toggle" bind:checked={$options.videoAutoplay} />
        </label>
      </div>

      <div class="form-control mb-4">
        <label class="label cursor-pointer">
          <span class="label-text">Hide from Compare</span>
          <input type="checkbox" class="toggle" bind:checked={$options.hideFromCompare} />
        </label>
      </div>

      <!-- Account: recovery address + password. Signed-in users only; there is
           nothing here a guest could act on. -->
      {#if $authToken && account}
        <div class="divider"></div>
        <details class="mb-4 rounded border border-base-300" bind:open={accountOpen}>
          <summary class="cursor-pointer select-none px-3 py-2 flex items-center gap-2">
            <span class="label-text font-semibold">Account</span>
            {#if account.needsEmail}
              <span class="badge badge-warning badge-sm">email needed</span>
            {:else if awaitingCode}
              <span class="badge badge-warning badge-sm">verify your email</span>
            {:else if account.emailVerified}
              <span class="badge badge-success badge-sm">protected</span>
            {:else}
              <span class="text-xs opacity-60">email, password</span>
            {/if}
          </summary>
          <div class="form-control px-3 pb-3">

          {#if account.needsEmail}
            <div class="alert alert-warning text-sm mb-2">
              <span>
                You are an admin with no verified email. Admin passwords cannot be
                reset from the login page, so without one there is no way back
                into this account.
              </span>
            </div>
          {/if}

          <p class="text-sm text-base-content/60 mb-2">
            {#if account.emailVerified}
              Password resets for <strong>{account.username}</strong> need a code
              emailed to <strong>{account.email}</strong>.
            {:else}
              Adding an email means a password reset needs a code sent to it.
              Without one, anyone who knows your username can reset this account.
            {/if}
          </p>

          <label class="label py-1" for="accountEmail">
            <span class="label-text text-sm">Email address</span>
          </label>
          <input
            id="accountEmail"
            class="input input-bordered input-sm mb-2"
            type="email"
            placeholder="you@example.com"
            bind:value={emailInput}
            disabled={accountBusy}
          />
          <input
            class="input input-bordered input-sm mb-2"
            type="password"
            placeholder="Current password"
            bind:value={emailPassword}
            disabled={accountBusy}
          />
          <button
            class="btn btn-sm btn-outline mb-2"
            on:click={saveEmail}
            disabled={accountBusy || !emailInput.trim() || !emailPassword}
          >
            {#if accountBusy}
              <span class="loading loading-spinner loading-xs"></span> Sending code...
            {:else}
              {account.email ? 'Update address' : 'Add address'}
            {/if}
          </button>

          <!-- Status sits ABOVE the code box: it is set before the request goes
               out, so it is the only thing on screen during the SMTP wait. -->
          {#if accountMessage}
            <div class="text-sm text-success mb-2">{accountMessage}</div>
          {/if}
          {#if accountError}
            <div class="text-sm text-error mb-2">{accountError}</div>
          {/if}

          {#if awaitingCode}
            <div class="rounded border border-warning/60 bg-warning/10 p-2 mb-2">
              <p class="text-sm mb-2">
                <strong>One more step.</strong> Enter the 6-digit code we sent{emailHint ? ` to ${emailHint}` : ''}.
                It expires in 10 minutes, and until you enter it this address
                protects nothing.
              </p>
              <div class="flex gap-2">
                <input
                  bind:this={codeInput}
                  class="input input-bordered input-sm flex-1 tracking-widest text-center"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength="6"
                  placeholder="000000"
                  bind:value={emailCode}
                  disabled={accountBusy}
                />
                <button class="btn btn-sm btn-primary" on:click={verifyEmail} disabled={accountBusy}>
                  {accountBusy ? 'Checking...' : 'Verify'}
                </button>
              </div>
            </div>
          {/if}

          <div class="label pt-2 pb-1">
            <span class="label-text text-sm font-semibold">Change password</span>
          </div>
          <input
            class="input input-bordered input-sm mb-2"
            type="password"
            placeholder="Current password"
            bind:value={currentPassword}
            disabled={accountBusy}
          />
          <input
            class="input input-bordered input-sm mb-2"
            type="password"
            placeholder="New password"
            bind:value={nextPassword}
            disabled={accountBusy}
          />
          <input
            class="input input-bordered input-sm mb-2"
            class:input-error={!!confirmPassword && confirmPassword !== nextPassword}
            type="password"
            placeholder="Confirm new password"
            bind:value={confirmPassword}
            disabled={accountBusy}
          />
          <button
            class="btn btn-sm btn-outline"
            on:click={changePassword}
            disabled={accountBusy || !currentPassword || !nextPassword || nextPassword !== confirmPassword}
          >
            {accountBusy ? 'Changing...' : 'Change password'}
          </button>
          {#if passwordMessage}
            <div class="text-sm text-success mt-2">{passwordMessage}</div>
          {/if}
          {#if passwordError}
            <div class="text-sm text-error mt-2">{passwordError}</div>
          {/if}
          </div>
        </details>
      {/if}

      <!-- Batch translation (admin only) -->
      {#if $authToken && batchIsAdmin}
        <div class="divider"></div>
        <div class="form-control mb-4">
          <div class="label"><span class="label-text font-semibold">Subtitle Pre-Translation</span></div>
          <p class="text-sm text-base-content/60 mb-2">
            Batch translate trailers using a higher quality model.
          </p>
          <div class="flex items-center gap-2 mb-2">
            <select class="select select-bordered select-sm" bind:value={batchSeason} disabled={batchRunning}>
              {#each SEASONS as s}
                <option value={s}>{s}</option>
              {/each}
            </select>
            <input
              type="number"
              class="input input-bordered input-sm w-24"
              bind:value={batchYear}
              disabled={batchRunning}
              min={2020}
              max={2030}
              data-bwignore
            />
          </div>
          <div class="flex gap-2">
            <button
              class="btn btn-sm btn-neutral"
              disabled={batchRunning}
              on:click={() => startBatch(true)}
            >
              Dry Run
            </button>
            <button
              class="btn btn-sm btn-primary"
              disabled={batchRunning}
              on:click={() => startBatch(false)}
            >
              {batchRunning ? 'Running...' : 'Start Batch'}
            </button>
          </div>
          {#if batchMessage}
            <p class="text-sm mt-2 text-base-content/70">{batchMessage}</p>
          {/if}
        </div>
      {/if}

      <div class="modal-action">
        <button class="btn" on:click={close}>Close</button>
      </div>
    </div>
  </div>
{/if}

<!-- Custom styles: none (tailwind classes cover it) -->
