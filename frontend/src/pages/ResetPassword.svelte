<script lang="ts">
  /**
   * Password reset - two paths behind one form.
   *
   * `/reset-request` decides which, and the page never guesses. An account with
   * a verified email gets a code; an account without one keeps the old
   * no-questions-asked reset; an admin who has not set an address yet gets a
   * dead end that says so, because there is deliberately no self-service route
   * for that case.
   *
   * The `blocked` step matters more than it looks: without it, an admin with no
   * address would sit at a form that refuses every submission, which reads as a
   * broken page rather than a policy.
   */
  import { onMount, tick } from 'svelte';

  type Step = 'username' | 'confirm' | 'code' | 'blocked' | 'success';
  let step: Step = 'username';
  let username = '';
  let newPassword = '';
  let code = '';
  let hint = '';
  let blockedMessage = '';
  let error = '';
  let loading = false;

  let userInput: HTMLInputElement;
  let passInput: HTMLInputElement;
  let codeInput: HTMLInputElement;

  onMount(() => userInput?.focus());

  async function continueToConfirm() {
    error = '';
    if (!username.trim()) {
      error = 'Please enter your username';
      return;
    }
    loading = true;
    try {
      const res = await fetch('/api/auth/reset-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      const data = await res.json();
      if (!res.ok) {
        error = data.error || 'Reset failed';
        return;
      }

      if (data.noAddress) {
        blockedMessage = data.message;
        step = 'blocked';
        return;
      }

      if (data.codeRequired) {
        hint = data.hint || '';
        step = 'code';
        await tick();
        codeInput?.focus();
        return;
      }

      step = 'confirm';
      await tick();
      passInput?.focus();
    } catch {
      error = 'Network error, please try again';
    } finally {
      loading = false;
    }
  }

  async function resetPassword() {
    error = '';
    if (!newPassword) {
      error = 'Please enter a new password';
      return;
    }
    loading = true;
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, newPassword })
      });
      const data = await res.json();
      if (!res.ok) {
        error = data.error || 'Reset failed';
        if (data.code === 'USER_NOT_FOUND') {
          step = 'username';
          username = '';
        }
        // The account gained protection between the two requests. Rather than
        // showing a refusal the user can do nothing about, send them back to
        // the start, where /reset-request will route them correctly.
        if (data.code === 'CODE_REQUIRED' || data.code === 'ADMIN_RESET_BLOCKED') {
          step = 'username';
          newPassword = '';
        }
        return;
      }
      step = 'success';
    } catch {
      error = 'Network error, please try again';
    } finally {
      loading = false;
    }
  }

  async function verifyCode() {
    error = '';
    if (!code.trim()) {
      error = 'Please enter the code from your email';
      return;
    }
    if (!newPassword) {
      error = 'Please enter a new password';
      return;
    }
    loading = true;
    try {
      const res = await fetch('/api/auth/reset-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, code: code.trim(), newPassword })
      });
      const data = await res.json();
      if (!res.ok) {
        error = data.error || 'Reset failed';
        // An expired or burnt-out code needs a new one, not another guess, so
        // clear the field rather than leaving a dead value in it.
        if (data.code === 'CODE_EXPIRED' || data.code === 'TOO_MANY_ATTEMPTS') code = '';
        return;
      }
      step = 'success';
    } catch {
      error = 'Network error, please try again';
    } finally {
      loading = false;
    }
  }

  function goBack() {
    step = 'username';
    error = '';
    newPassword = '';
    code = '';
    hint = '';
  }

  function goToLogin() {
    window.history.pushState({}, '', '/login');
    dispatchEvent(new PopStateEvent('popstate'));
  }
</script>

<div class="max-w-sm mx-auto my-20 p-6 shadow rounded bg-base-200 space-y-4">
  <h2 class="text-xl font-bold text-center">Reset Password</h2>

  {#if error}
    <div class="text-error text-sm">{error}</div>
  {/if}

  {#if step === 'username'}
    <form on:submit|preventDefault={continueToConfirm} class="space-y-4">
      <input bind:this={userInput} class="input w-full" placeholder="Username" bind:value={username} />
      <button class="btn btn-primary w-full" type="submit" disabled={loading}>
        {loading ? 'Checking...' : 'Continue'}
      </button>
      <p class="text-sm text-center">
        <a href="/login" class="link" on:click|preventDefault={goToLogin}>Back to login</a>
      </p>
    </form>
  {:else if step === 'confirm'}
    <form on:submit|preventDefault={resetPassword} class="space-y-4">
      <p class="text-sm">Reset password for <strong>{username}</strong>?</p>
      <input bind:this={passInput} class="input w-full" type="password" placeholder="New password" bind:value={newPassword} />
      <button class="btn btn-primary w-full" type="submit" disabled={loading}>
        {loading ? 'Resetting...' : 'Reset Password'}
      </button>
      <button type="button" class="btn btn-ghost w-full btn-sm" on:click={goBack}>Back</button>
    </form>
  {:else if step === 'code'}
    <form on:submit|preventDefault={verifyCode} class="space-y-4">
      <p class="text-sm">
        We sent a 6-digit code to <strong>{hint}</strong>. It expires in 10 minutes
        and can be used once.
      </p>
      <input
        bind:this={codeInput}
        class="input w-full tracking-widest text-center"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        placeholder="000000"
        bind:value={code}
      />
      <input class="input w-full" type="password" placeholder="New password" bind:value={newPassword} />
      <button class="btn btn-primary w-full" type="submit" disabled={loading}>
        {loading ? 'Resetting...' : 'Reset Password'}
      </button>
      <button type="button" class="btn btn-ghost w-full btn-sm" on:click={goBack}>Back</button>
    </form>
  {:else if step === 'blocked'}
    <div class="space-y-4">
      <div class="alert alert-warning text-sm">
        <span>{blockedMessage}</span>
      </div>
      <button type="button" class="btn btn-ghost w-full btn-sm" on:click={goBack}>Back</button>
      <p class="text-sm text-center">
        <a href="/login" class="link" on:click|preventDefault={goToLogin}>Back to login</a>
      </p>
    </div>
  {:else}
    <p class="text-sm text-center">Password updated successfully.</p>
    <button class="btn btn-primary w-full" on:click={goToLogin}>Log in here &rarr;</button>
  {/if}
</div>
