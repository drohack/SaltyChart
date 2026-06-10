<script lang="ts">
  import { onMount, tick } from 'svelte';

  type Step = 'username' | 'confirm' | 'success';
  let step: Step = 'username';
  let username = '';
  let newPassword = '';
  let error = '';
  let loading = false;

  let userInput: HTMLInputElement;
  let passInput: HTMLInputElement;

  onMount(() => userInput?.focus());

  async function continueToConfirm() {
    error = '';
    if (!username.trim()) {
      error = 'Please enter your username';
      return;
    }
    step = 'confirm';
    await tick();
    passInput?.focus();
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
      <button class="btn btn-primary w-full" type="submit">Continue</button>
      <p class="text-sm text-center">
        <a href="/login" class="link" on:click|preventDefault={goToLogin}>Back to login</a>
      </p>
    </form>
  {:else if step === 'confirm'}
    <form on:submit|preventDefault={resetPassword} class="space-y-4">
      <p class="text-sm">Reset password for <strong>{username}</strong>?</p>
      <input bind:this={passInput} class="input w-full" type="password" placeholder="New password" bind:value={newPassword} />
      <button class="btn btn-primary w-full" type="submit" disabled={loading}>
        {loading ? 'Resetting…' : 'Reset Password'}
      </button>
      <button type="button" class="btn btn-ghost w-full btn-sm" on:click={goBack}>Back</button>
    </form>
  {:else}
    <p class="text-sm text-center">Password updated successfully.</p>
    <button class="btn btn-primary w-full" on:click={goToLogin}>Log in here →</button>
  {/if}
</div>
