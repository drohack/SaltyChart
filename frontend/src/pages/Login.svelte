<script lang="ts">
import { authToken, userName } from '../stores/auth';

  let username = '';
  let password = '';
  let error = '';

  let userInput: HTMLInputElement;

  import { onMount } from 'svelte';
  onMount(() => {
    userInput?.focus();
  });

  async function submit() {
    error = '';
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const data = await res.json();
      error = data.error || 'Login failed';
      return;
    }
    const { token } = await res.json();
    authToken.set(token);
    userName.set(username);
    // Navigate home
    window.history.pushState({}, '', '/');
    const navEvent = new PopStateEvent('popstate');
    dispatchEvent(navEvent);
  }
</script>

<form on:submit|preventDefault={submit} class="max-w-sm mx-auto my-20 p-6 shadow rounded bg-base-200 space-y-4">
  <h2 class="text-xl font-bold text-center">Login</h2>
  {#if error}
    <div class="text-error text-sm">{error}</div>
  {/if}
  <input bind:this={userInput} class="input w-full" placeholder="Username" bind:value={username} />
  <input class="input w-full" type="password" placeholder="Password" bind:value={password} />
  <button class="btn btn-primary w-full" type="submit">Login</button>
</form>
