<script lang="ts">
  import Home from './pages/Home.svelte';
  import Login from './pages/Login.svelte';
  import SignUp from './pages/SignUp.svelte';
  import Randomize from './pages/Randomize.svelte';
import { authToken, userName } from './stores/auth';

  // simple client-side router using location.pathname
  import { onMount } from 'svelte';

  let route = window.location.pathname;

  onMount(() => {
    window.addEventListener('popstate', () => (route = window.location.pathname));
  });

  function goto(path: string) {
    if (route === path) return;
    history.pushState({}, '', path);
    route = path;
  }

  $: Page = route === '/login'
    ? Login
    : route === '/signup'
    ? SignUp
    : route === '/random'
    ? Randomize
    : Home;
</script>

<header class="flex justify-between items-center p-4 w-full md:w-3/4 mx-auto">
  <!-- Logo / Home link -->
  <h1 class="text-3xl font-bold">
    <a
      href="/"
      class="cursor-pointer"
      on:click|preventDefault={() => goto('/')}
    >
      SaltyChart
    </a>
  </h1>

  <nav class="flex items-center gap-6 text-lg">
    <a href="/" class="link" on:click|preventDefault={() => goto('/')}>Anime</a>
    <a href="/random" class="link" on:click|preventDefault={() => goto('/random')}>Randomize</a>
  </nav>

  <div class="flex items-center gap-4">
    {#if $authToken}
      <span>{$userName}</span>
      <button
        type="button"
        class="link"
        on:click={() => {
          authToken.set(null);
          userName.set(null);
        }}
      >
        Logout
      </button>
    {:else}
      <a
        href="/login"
        class="link"
        on:click|preventDefault={() => goto('/login')}
      >
        Login
      </a>
      <a
        href="/signup"
        class="link"
        on:click|preventDefault={() => goto('/signup')}
      >
        Sign Up
      </a>
    {/if}
  </div>
</header>

<svelte:component this={Page} />
