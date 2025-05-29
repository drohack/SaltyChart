<script lang="ts">
  import Home from './pages/Home.svelte';
  import Login from './pages/Login.svelte';
  import SignUp from './pages/SignUp.svelte';
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

  $: Page = route === '/login' ? Login : route === '/signup' ? SignUp : Home;
</script>

<header class="flex justify-between items-center p-4 w-full md:w-3/4 mx-auto">
  <h1 class="text-3xl font-bold cursor-pointer" on:click={() => goto('/')}>SaltyChart</h1>

  <div class="flex items-center gap-4">
    {#if $authToken}
      <span>{$userName}</span>
      <button class="link" on:click={() => { authToken.set(null); userName.set(null); }}>Logout</button>
    {:else}
      <a class="link" on:click={() => goto('/login')}>Login</a>
      <a class="link" on:click={() => goto('/signup')}>Sign Up</a>
    {/if}
  </div>
</header>

<svelte:component this={Page} />
