<script lang="ts">
import SeasonSelect from '../components/SeasonSelect.svelte';
import { authToken, userName as activeUserName } from '../stores/auth';
import { seasonYear } from '../stores/season';
import { get } from 'svelte/store';
import { options } from '../stores/options';
import LoadingSpinner from '../components/LoadingSpinner.svelte';
import { onMount } from 'svelte';
import { allUsers as nicknameAllUsers, selectedUsers as nicknameSelected, toggleUser as toggleNicknameUser } from '../stores/nicknameUsers';
// Reactive trigger for title-language changes
$: _lang = $options.titleLanguage;

  import type { Season } from '../stores/season';

  let season: Season = get(seasonYear).season;
  let year: number = get(seasonYear).year;

  // Push local changes back to store
  let _lastKey = `${season}-${year}`;
  $: {
    const key = `${season}-${year}`;
    if (key !== _lastKey) {
      _lastKey = key;
      seasonYear.set({ season, year });
    }
  }

  // User list for current season/year
  let watchList: any[] = [];
  let anime: any[] = [];

  // Lists derived later but need initial declaration for TS
  let unwatchedDetailed: any[] = [];

  // Sort mode for unwatched list: 'rank' (default) or 'alphabetical'
  let unwatchedSortMode: 'rank' | 'alphabetical' = 'rank';

  // Wheel DOM reference & animation state
  let wheelEl: HTMLDivElement;
  let rotation = 0; // degrees
  let spinning = false;

  // Selected item after spin
  let selected: any = null;
  // Track last selected wheel item ID to avoid immediate repeats
  let lastSelectedId: number | null = null;

  // Derived: current user rank for selected show (1-based).  Null when not
  // watched or rank not set.
  $: myRank = selected
    ? (() => {
        const idx = watchList.findIndex((w) => w.mediaId === selected.id);
        return idx === -1 ? null : idx + 1;
      })()
    : null;
  let nicknameList: Array<{ userName: string; nickname: string | null; rank: number | null }> = [];

  // --------------------------------------------------------------
  // Hide / Show all helpers for the Unwatched list
  // --------------------------------------------------------------

  // Derived: whether every unwatched entry is currently hidden.
  $: allHidden = unwatchedDetailed.length > 0 && unwatchedDetailed.every((it) => it.hidden);

  $: hasHidden = unwatchedDetailed.some((it) => it.hidden);
  $: hasVisible = unwatchedDetailed.some((it) => !it.hidden);

  // Helper to update hidden flag in bulk
  async function setHiddenForAll(targetHidden: boolean) {
    if (!$authToken) return;

    const targets = unwatchedDetailed.filter((it) => it.hidden !== targetHidden);

    watchList = watchList.map((entry) => {
      const hit = targets.find((t) => t.id === entry.mediaId);
      return hit ? { ...entry, hidden: targetHidden } : entry;
    });

    for (const item of targets) {
      fetch('/api/list/hidden', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${$authToken}`
        },
        body: JSON.stringify({ season, year, mediaId: item.id, hidden: targetHidden })
      }).catch(() => {});
    }
  }

  const hideAll = () => setHiddenForAll(true);
  const showAll = () => setHiddenForAll(false);

  /**
   * Toggle the `hidden` flag for a single item.
   *
   * We update the local `watchList` optimistically so the UI responds
   * instantly, then fire-and-forget the PATCH request.  Any failure will be
   * logged to the console and the list will be refreshed on the next full
   * fetch, keeping the code simple while delivering snappy UX.
   */
  function toggleHide(item: any) {
    if (!$authToken) return;

    // --- Optimistic local update (no awaiting network) -------------------
    watchList = watchList.map((w) =>
      w.mediaId === item.id ? { ...w, hidden: !item.hidden } : w
    );

    // Background persistence – we don't await the result to keep the UI fast
    fetch('/api/list/hidden', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${$authToken}`
      },
      body: JSON.stringify({
        season,
        year,
        mediaId: item.id,
        hidden: !item.hidden
      })
    }).catch((err) => {
      // Note: If the request fails the UI might become out-of-sync until the
      // next list refresh, which is acceptable and still better than blocking
      // every click for 2 seconds in production.
      console.error('Failed to toggle hidden', err);
    });
  }

  // Fetch nickname list whenever modal opens (and selected differs)
  $: if (showModal && selected) {
    (async () => {
      try {
        const res = await fetch(`/api/list/nicknames?mediaId=${selected.id}`);
        nicknameList = res.ok ? await res.json() : [];
      } catch {
        nicknameList = [];
      }
    })();
  }

  // Loading state while fetching list & anime
  let loading = false;

  // ------------------------------------------------------------------
  // Mobile sidebar collapse state (unwatched & watched lists)
  // ------------------------------------------------------------------

  let unwatchedCollapsed = true;
  let watchedCollapsed = true;

  onMount(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      unwatchedCollapsed = false;
      watchedCollapsed = false;
    }
  });

  function showUnwatched() {
    unwatchedCollapsed = false;
    watchedCollapsed = true;
  }

  function showWatched() {
    watchedCollapsed = false;
    unwatchedCollapsed = true;
  }

  // ------------------------------------------------------------------
  // Guard: page only makes sense when the user is logged-in.  When the
  // token disappears (logout) we reset state *and* navigate away to the
  // home page so users don’t interact with a stale wheel.
  // ------------------------------------------------------------------

  $: if (!$authToken) {
    // Clear all derived lists and UI state
    watchList = [];
    anime = [];
    rotation = 0;
    selected = null;

    // If user somehow reached this page while logged-out, kick back home
    if (typeof window !== 'undefined' && window.location.pathname === '/random') {
      history.replaceState({}, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  // Fetch list from backend
  async function fetchList() {
    if (!$authToken) {
      watchList = [];
      return;
    }
    const res = await fetch(`/api/list?season=${season}&year=${year}`, {
      headers: { Authorization: `Bearer ${$authToken}` }
    });
    if (res.ok) watchList = await res.json();
  }

  async function fetchAnime() {
    const res = await fetch(`/api/anime?season=${season}&year=${year}`);
    if (res.ok) anime = await res.json();
  }


  const fetchBoth = async () => {
    loading = true;
    try {
      await Promise.all([fetchList(), fetchAnime()]);
    } finally {
      loading = false;
    }
  };

  // Track last fetched year/season to avoid duplicate loads.
  let lastSeasonYearKey: string | null = null;

  // Initial & subsequent fetches.
  $: {
    const key = `${season}-${year}`;
    if (key !== lastSeasonYearKey) {
      lastSeasonYearKey = key;
      fetchBoth();
    }
  }

  // ------------------------------------------------------------------
  // Nickname user list fetch & store sync
  // ------------------------------------------------------------------

  onMount(async () => {
    try {
      const res = await fetch('/api/list/users-with-nicknames');
      if (res.ok) {
        let users: string[] = await res.json();

        // Exclude the currently-logged in user from the selectable list so the
        // panel only shows *other* users.  (The active user will always see
        // their own custom names regardless of this filter.)
        const self = get(activeUserName);
        if (self) users = users.filter((u) => u !== self);

        nicknameAllUsers.set(users);

        // Sync current selection with new user list:
        nicknameSelected.update((prev) => {
          // Remove self from previous selection
          const self = get(activeUserName);
          const cleaned = new Set<string>([...prev].filter((u) => u !== self));

          // Retain only users still present in latest list
          const next = new Set<string>();
          cleaned.forEach((u) => {
            if (users.includes(u)) next.add(u);
          });

          // If no persisted selection exists (first visit) default to all
          if (next.size === 0) {
            const hadPersisted = typeof localStorage !== 'undefined' && !!localStorage.getItem('nickUserSel');
            return hadPersisted ? next : new Set(users);
          }
          return next;
        });
      }
    } catch (err) {
      console.error('Failed to fetch nickname user list', err);
    }
  });

  // Separate entries into watched/unwatched for easier handling.
  //  * watchedEntries is needed for the ranking sidebar.
  //  * We no longer hide watched shows from the left sidebar – that list now
  //    shows *all* items but greys-out the ones already watched.

  $: watchedEntries = watchList.filter((w) => w.watched);
$: unwatchedEntries = watchList.filter((w) => !w.watched && !w.hidden);

  // Build wheel items with full anime data, but only for entries that have
  // NOT been watched yet so we never spin on already-watched shows.
  $: wheelItems = unwatchedEntries
    .map((w) => {
      const data = anime.find((a) => a.id === w.mediaId);
      return data ? { ...data, customName: w.customName ?? null } : null;
    })
    .filter(Boolean);

  // (Watched ranking is handled separately – see watchedRank below)

  // Detailed list used for the left sidebar.  It now shows *all* shows in the
  // watch list (both watched & unwatched) so users can always see the full
  // season list.
  $: fullDetailed = watchList
    .map((w) => {
      const data = anime.find((a) => a.id === w.mediaId);
      return data
        ? {
            ...data,
            customName: w.customName ?? null,
            watched: w.watched ?? Boolean(w.watchedAt),
            hidden: Boolean(w.hidden)
          }
        : null;
    })
    .filter(Boolean);

  // Filtered list for the sidebar: only items that are still UNwatched.
  $: unwatchedDetailed = fullDetailed.filter((i) => !i.watched);

  // Apply sorting based on user selection
  $: unwatchedSorted = (() => {
    const list = [...unwatchedDetailed]; // Create a copy to avoid mutating original

    if (unwatchedSortMode === 'alphabetical') {
      list.sort((a, b) => {
        const titleA = getDisplayTitle(a).toLowerCase();
        const titleB = getDisplayTitle(b).toLowerCase();
        return titleA.localeCompare(titleB);
      });
    }
    // For 'rank' mode, keep the original order (no sorting needed)

    return list;
  })();

  // Client-side ranking list for watched items.  Initially seeded from
  // watchedDetailed (sorted by watchedAt) and updated whenever the user
  // drags items in the ranking sidebar.
  let watchedRank: any[] = [];

  // Seed watchedRank whenever the underlying watched list changes *and* the
  // rank array does not already include the same set of IDs.  This preserves
  // the user’s manual ordering across reactive re-computations triggered by
  // other state (e.g. title-language switch, rename, etc.).
  $: {
    const ids = watchedEntries.map((w) => w.mediaId);
    const rankIds = watchedRank.map((i) => i.id);
    if (ids.length !== rankIds.length || ids.some((id) => !rankIds.includes(id))) {
      // Build fresh detailed list in default watchedAt order
      const detailed = watchedEntries
        .map((w) => {
          const data = anime.find((a) => a.id === w.mediaId);
          return data
            ? {
                ...data,
                customName: w.customName ?? null,
                watchedAt: w.watchedAt ?? null,
                watched: true,
                watchedRank: w.watchedRank ?? null
              }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.watchedRank != null && b.watchedRank != null) return a.watchedRank - b.watchedRank;
          if (a.watchedRank != null) return -1;
          if (b.watchedRank != null) return 1;
          const t1 = a.watchedAt ? new Date(a.watchedAt).getTime() : 0;
          const t2 = b.watchedAt ? new Date(b.watchedAt).getTime() : 0;
          return t1 - t2;
        });

      watchedRank = detailed;
    }
  }

  // Derived values for wheel rendering
import SliceWorker from '../workers/slice-worker?worker';


  import WatchedRankingSidebar from '../components/WatchedRankingSidebar.svelte';
import { onDestroy } from 'svelte';
const sliceWorker: Worker = new SliceWorker();

  // -----------------------------
  // Audio helpers (ping + tick)
  // -----------------------------

  const audioCtx: AudioContext | null = typeof window !== 'undefined'
    ? new (window.AudioContext || (window as any).webkitAudioContext)()
    : null;

  function playTone(frequency: number, duration = 0.1, type: OscillatorType = 'sine', gainLevel = 0.3) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainLevel, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  function playPing() {
    playTone(880, 0.25, 'sine', 0.4);
  }

  function playTick() {
    /*
     * More organic click made from a short burst of white noise passed through
     * a low-pass filter with exponential volume decay.  This avoids the
     * robotic “beep” character of pure oscillators while staying file-less.
     */
    if (!audioCtx) return;

    const duration = 0.07; // seconds

    // Create noise buffer
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // White noise in [-1,1]
      data[i] = Math.random() * 2 - 1;
    }

    // Buffer source
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;

    // Low-pass filter to make it less harsh (cut ~1 kHz)
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1000, audioCtx.currentTime);

    // Gain envelope for quick decay
    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.5, now); // initial volume 50 %
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    source.connect(filter).connect(gain).connect(audioCtx.destination);
    source.start(now);
    source.stop(now + duration);
  }

  // Quick, soft click played when the user presses the Spin button.
  function playStartClick() {
    if (!audioCtx) return;
    // Simple triangle blip – clearer than filtered noise; very short.
    playTone(500, 0.04, 'triangle', 0.22);
  }

  // ------------------------------------------------------------
  // Celebration helpers (called when wheel stops)
  // ------------------------------------------------------------

  function celebrate() {
    playCelebrationTune();
    launchConfetti();
  }

  function playCelebrationTune() {
    if (!audioCtx) return;

    /*
     * Softer “trumpet-ish” celebration riff:
     *   • Triangle waveform for a brassy but less harsh timbre.
     *   • Gentle low-pass filter sweeps on each note.
     *   • Reduced gain so it sits underneath the UI sounds.
     */

    if (!audioCtx) return;

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C-major arpeggio

    notes.forEach((freq, i) => {
      setTimeout(() => {
        const now = audioCtx.currentTime;

        // Oscillator
        const osc = audioCtx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now);

        // Low-pass filter to mellow the tone (trumpet-like)
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.linearRampToValueAtTime(1200, now + 0.3);

        // Gain envelope
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        osc.connect(filter).connect(gain).connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.45);
      }, i * 200);
    });
  }

  function launchConfetti() {
    if (typeof window === 'undefined') return;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '90';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const confettiCount = 160;
    const confetti: { x: number; y: number; vx: number; vy: number; size: number; color: string; rot: number; vr: number }[] = [];
    const colors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6'];

    for (let i = 0; i < confettiCount; i++) {
      confetti.push({
        // Start near center bottom half so they burst upward from wheel area
        x: canvas.width / 2 + (Math.random() - 0.5) * 120,
        y: canvas.height * 0.6,
        // radial burst velocity upward
        vx: (Math.random() - 0.5) * 6,
        vy: -(Math.random() * 6 + 4),
        size: Math.random() * 6 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 10
      });
    }

    let lastTime = performance.now();
    function draw(now: number) {
      const dt = (now - lastTime) / 16.666; // 60fps units
      lastTime = now;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      confetti.forEach((p) => {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.12 * dt; // gravity stronger for longer duration
        p.rot += p.vr * dt;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      });

      animationFrame = requestAnimationFrame(draw);
    }

    let animationFrame = requestAnimationFrame(draw);

    // Clean up after 5 seconds
    setTimeout(() => {
      cancelAnimationFrame(animationFrame);
      canvas.remove();
    }, 5000);
  }

  let sliceAngle = 0;
  let sliceData: { start: number; end: number; color: string }[] = [];

  sliceWorker.onmessage = (ev) => {
    sliceAngle = ev.data.sliceAngle;
    sliceData = ev.data.sliceData;
  };

  $: sliceWorker.postMessage({ count: wheelItems.length });

  // radial distance for label (in SVG units, radius is 50)
  const LABEL_R_OUTER = 48; // near rim (SVG units, radius is 50)
  const LABEL_CHAR_LIMIT = 24;

  function spin() {
    if (!wheelItems.length || spinning) return;

    // Ensure AudioContext is resumed (required after user gesture).
    if (audioCtx?.state === 'suspended') {
      audioCtx.resume();
    }

    // Soft initial click on user interaction (after context resumed)
    playStartClick();
    spinning = true;

    let idx = Math.floor(Math.random() * wheelItems.length);
    if (wheelItems.length > 1 && lastSelectedId !== null && wheelItems[idx].id === lastSelectedId) {
      // Re-roll once to avoid immediate repeat.  Second random value guarantees change.
      idx = (idx + 1 + Math.floor(Math.random() * (wheelItems.length - 1))) % wheelItems.length;
    }
    const segAngle = 360 / wheelItems.length;

    const POINTER_OFFSET = 0; // pointer located at 12 o’clock (top-center)

    // Desired angle of selected slice centre relative to pointer
    const targetAngle = (wheelItems.length - idx - 0.5) * segAngle + POINTER_OFFSET;

    // Current wheel angle (0-359)
    const currentAngle = ((rotation % 360) + 360) % 360;
    let delta = targetAngle - currentAngle;
    if (delta <= 0) delta += 360;
    // add at least 720° extra spins every time
    delta += 720;

    if (wheelEl) {
      wheelEl.style.transition = 'none';
      wheelEl.getBoundingClientRect(); // force reflow
      wheelEl.style.transition = 'transform 4s cubic-bezier(.33,.85,.25,1)';
    }

    rotation += delta;
    selected = wheelItems[idx];
    lastSelectedId = selected.id;

    // ------------------------------------------------------------------
    // Schedule tick sounds for every slice the pointer crosses while the
    // wheel is spinning.  We approximate the timing by distributing the
    // ticks evenly across the 4 s CSS transition duration.
    // ------------------------------------------------------------------

    // Number of slice boundaries crossed during rotation
    const ticks = Math.floor(delta / segAngle);
    const durationMs = 4000; // CSS transition duration

    // Limit audible ticks so they don’t become an overwhelming buzz when many
    // slices are present.  We cap to ~25 clicks by skipping evenly.
    const MAX_AUDIBLE_TICKS = 40;
    const skipFactor = Math.max(1, Math.ceil(ticks / MAX_AUDIBLE_TICKS));

    // Inverse of ease-out cubic (matches CSS cubic-bezier curve reasonably well)
    const easeOutCubicInv = (p: number) => 1 - Math.cbrt(1 - p);

    for (let i = 1; i <= ticks; i++) {
      if (i % skipFactor !== 0) continue; // skip excess ticks
      const angleFrac = i / ticks;
      const timeFrac = easeOutCubicInv(angleFrac);
      setTimeout(playTick, timeFrac * durationMs);
    }
  }

  let showModal = false;

/**
 * Handle keydown events inside the modal so that pressing the <Enter> key is
 * equivalent to clicking the “Mark as watched” button.  We purposefully scope
 * the listener to the dialog element to avoid catching unrelated key presses
 * elsewhere in the page.
 */
// Global key handler (attached while modal is open) so the Enter key triggers
// the same action irrespective of which element currently has focus.
function handleModalKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    markWatched();
  }

}

// Clean-up in case the component is destroyed while the modal is open
onDestroy(() => {
  window.removeEventListener('keydown', handleModalKey);
});

// Dynamically attach / detach the listener whenever modal visibility changes.
$: {
  if (showModal) {
    window.addEventListener('keydown', handleModalKey);
  } else {
    window.removeEventListener('keydown', handleModalKey);
  }
}

  /**
   * Mark the currently selected series as watched.
   *
   * 1. Update local state so the UI reflects the change immediately.
   * 2. Notify backend so the change is persisted.
   */
  async function markWatched() {
    if (!selected) return;

    // Close the modal immediately so the UI feels responsive.
    showModal = false;

    // Update local + remote state without blocking the UI. The helper updates
    // local lists synchronously, while the fetch runs in the background.
    toggleWatched(selected.id, true);
  }

  /**
   * Hide the currently selected series from the wheel. This is called from the
   * modal and provides an alternative to marking the series as watched when the
   * user decides they don't want to see it in the randomizer.
   */
  async function hideSelectedSeries() {
    if (!selected) return;

    // Find the corresponding entry in unwatchedDetailed that has the full structure
    // including the hidden property that toggleHide expects
    const entry = unwatchedDetailed.find((item) => item.id === selected.id);

    if (entry) {
      // Close modal immediately for responsive UI
      showModal = false;

      // Call existing toggleHide which handles optimistic update + API call
      toggleHide(entry);
    }
  }

  /** Toggle watched flag for a given mediaId */
  async function toggleWatched(id: number, watched: boolean) {
    // update local state
    watchList = watchList.map((w) =>
      w.mediaId === id
        ? {
            ...w,
            watched,
            watchedAt: watched ? new Date().toISOString() : null,
            watchedRank: watched ? (watchedRank.length) : null
          }
        : w
    );

    // Keep the watchedRank sidebar in sync immediately so the user sees the
    // new entry without waiting for the reactive regeneration to kick in.
    if (watched) {
      // Avoid duplicates in case the item is already present.
      if (!watchedRank.some((it) => it.id === id)) {
        const data = anime.find((a) => a.id === id);
        const entry = watchList.find((w) => w.mediaId === id);
        if (data && entry) {
          watchedRank = [
            ...watchedRank,
            {
              ...data,
              customName: entry.customName ?? null,
              watched: true,
              watchedAt: entry.watchedAt ?? null,
              watchedRank: watchedRank.length
            }
          ];
        }
      }
    } else {
      // Remove from local ranking list when un-watched
      watchedRank = watchedRank.filter((it) => it.id !== id);
    }

    if ($authToken) {
      try {
        await fetch('/api/list/watched', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${$authToken}`
          },
          body: JSON.stringify({ season, year, mediaId: id, watched })
        });
      } catch (err) {
        console.error('Failed to update watched flag', err);
      }
    }
  }

  // Helper to build SVG arc path
  function polar(cx: number, cy: number, r: number, ang: number) {
    const rad = (ang - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(cx: number, cy: number, r: number, start: number, sweep: number): string {
    const startPt = polar(cx, cy, r, start);
    const endPt = polar(cx, cy, r, start + sweep);
    const large = sweep > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${startPt.x} ${startPt.y} A ${r} ${r} 0 ${large} 1 ${endPt.x} ${endPt.y} Z`;
  }

  /**
   * Get display title based on preference, truncating for wheel labels.
   */
  function getDisplayTitle(item: any): string {
    if (item.customName) return item.customName;
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  /**
   * Get original title based on preference, ignoring any customName.
   */
  function getBaseTitle(item: any): string {
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  function shortTitle(item: any): string {
    const title = getDisplayTitle(item);
    return title.length > LABEL_CHAR_LIMIT ? title.slice(0, LABEL_CHAR_LIMIT - 1) + '…' : title;
}


</script>

<main class="px-4 pt-4 pb-0 flex flex-col gap-8">
  <!-- Controls aligned to header -->
  <div class="w-full md:w-3/4 mx-auto">
    <SeasonSelect
      bind:season
      bind:year
      showListToggle={false}
      showSequelToggle={false}
      hideSequels={false}
      hideInList={false}
      showSearch={false}
    />
  </div>

  <!-- Container: wheel grows to fill remaining space -->
  <div class="relative w-full flex justify-center items-center overflow-visible flex-1" style="min-height: min(95vmin, calc(100dvh - 195px));">
    <div class="flex flex-col items-center mx-auto">
      {#if loading}
        <LoadingSpinner size="lg" />
      {:else if !wheelItems.length}
        <div class="mt-24 text-center opacity-70">My List for this season is empty.</div>
      {:else}
        <!-- Wheel -->
        <div
          id="wheel-wrapper"
          class="relative mx-auto overflow-visible"
          style="
            /* 52 header + 72 selector + 52 extra + 19 buffer → 195px total */
            width: min(95vmin, calc(100dvh - 195px));
            height: min(95vmin, calc(100dvh - 195px));
            margin-bottom: 5px; /* keep a sliver of space below wheel */
            z-index: 1;
          "
        >
          <!-- Clipped wheel -->
          <div class="overflow-hidden rounded-full w-full h-full">
        <svg
          bind:this={wheelEl}
          viewBox="-50 -50 100 100"
          style="width:100%;height:100%;will-change:transform;backface-visibility:hidden;transform:translateZ(0) rotate({rotation}deg);"
          class="transition-transform pointer-events-none"
        on:transitionend={() => {
          if (spinning) {
            spinning = false;
            celebrate();
            // Slight delay before showing modal so confetti is visible underneath
            setTimeout(() => (showModal = true), 50);
          }
        }}
      >
        <!-- draw slices -->
        {#each sliceData as s}
          <g transform="rotate({s.start})">
            <path d={arcPath(0, 0, 50, 0, sliceAngle)} fill={s.color} />
          </g>
        {/each}

        <!-- draw labels on top -->
        {#each wheelItems as item, i (item.id)}
          {#key $options.titleLanguage + '-' + item.id}
          <!-- rotate label to centre of slice.
               Polar helper uses 0° at 12 o’clock, but CSS/SVG rotate() uses 0° at 3 o’clock → offset -90° -->
          <g transform={`rotate(${sliceAngle * i + sliceAngle / 2 - 90})`}>
            <text
              fill="white"
              font-size="2.5"
              text-anchor="start"
              alignment-baseline="middle"
              transform={`rotate(180) translate(-${LABEL_R_OUTER},0)`}
              style="pointer-events:none;stroke:#000;stroke-width:.25;paint-order:stroke;white-space:pre;">
              {shortTitle(item)}
            </text>
          </g>
          {/key}
        {/each}
        </svg>
      </div>


      <!-- Central Spin button -->
      <button
        class={`group btn btn-primary btn-circle active:shadow-inner active:scale-95 transition-transform duration-75 absolute inset-0 m-auto w-28 h-28 md:w-36 md:h-36 shadow-lg flex items-center justify-center text-2xl select-none ${spinning ? 'pointer-events-none opacity-75' : ''}`}
        on:click={spin}
        style="z-index: 10;"
      >
        Spin

        <!-- Upward pointer protruding from top half of button -->
        <svg
          class={`absolute left-1/2 top-0 -translate-x-1/2 -translate-y-2/3 w-12 h-12 md:w-16 md:h-16 fill-current text-primary pointer-events-none ${spinning ? 'opacity-75' : ''}`}
          style="z-index: -1;"
          viewBox="0 0 24 30"
        >
          <path d="M12 0 L22 28 H2 Z" />
        </svg>
      </button>
    </div>
  {/if}
    
  </div> <!-- end wheel column -->

    <!-- Unwatched list sidebar -->
    <aside
      class="fixed z-40 top-0 bottom-0 left-0 bg-base-200 pr-4 pl-4 py-3 shadow-lg flex flex-col w-full max-w-[20rem] lg:absolute lg:mt-0 lg:w-64 3cols:lg:w-80 transform transition-transform duration-300 overflow-hidden lg:translate-x-0"
      class:-translate-x-full={unwatchedCollapsed}
      style="max-height: calc(100dvh - 0px);"
    >
      {#if unwatchedDetailed.length}
        <div class="mb-4 pr-2">
          <!-- Row 1: Title and Sort -->
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-lg font-bold text-center md:text-left">Unwatched</h3>

            <!-- Hide tab (mobile only) -->
            <button
              class="lg:hidden absolute right-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-r px-1 py-6 shadow flex items-center justify-center z-50"
              style="width: 1.25rem;"
              aria-label="Hide Unwatched list"
              on:click={() => (unwatchedCollapsed = true)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <!-- Chevron pointing left (<) -->
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            <!-- Sort dropdown -->
            {#if $authToken}
              <select bind:value={unwatchedSortMode} class="select select-xs">
                <option value="rank">Rank</option>
                <option value="alphabetical">A-Z</option>
              </select>
            {/if}
          </div>

          <!-- Row 2: Hide/Show All buttons -->
          {#if $authToken}
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="btn btn-xs btn-outline normal-case filter brightness-75 hover:brightness-100"
                on:click={hideAll}
                disabled={!hasVisible}
              >
                Hide All
              </button>
              <button
                type="button"
                class="btn btn-xs btn-outline normal-case filter brightness-75 hover:brightness-100"
                on:click={showAll}
                disabled={!hasHidden}
              >
                Show All
              </button>
            </div>
          {/if}
        </div>
        <ul class="flex-1 overflow-y-auto flex flex-col gap-3 pr-1">
          {#each unwatchedSorted as item (item.id)}
            <li
              class={`flex items-center gap-3 group transition rounded p-1 ${
                item.watched
                  ? 'opacity-40 pointer-events-none'
                  : item.hidden
                  ? 'opacity-40'
                  : 'cursor-pointer hover:bg-primary/20 hover:shadow-md'
              }`}
              on:click={() => {
                if (!item.watched && !item.hidden) {
                  selected = item;
                  showModal = true;
                }
              }}
            >
              <img
                src={item.coverImage?.small ?? item.coverImage?.medium ?? item.coverImage?.large}
                alt=""
                class="w-12 h-16 object-cover rounded shrink-0"
                loading="lazy"
              />

              {#key $options.titleLanguage + '-' + item.id}
                <span
                  class="text-sm flex-1 whitespace-normal break-words force-wrap"
                  title={getDisplayTitle(item)}
                  data-lang={$options.titleLanguage}
                  >{item.customName || getDisplayTitle(item)}</span
                >
              {/key}

              <!-- Eye toggle -->
              <button
                type="button"
                class={`shrink-0 ml-auto mr-2 relative p-4 -m-3 rounded-full hover:bg-base-300 transition \
                  ${item.hidden ? '' : 'opacity-0 group-hover:opacity-100'}`}
                on:click|stopPropagation={() => toggleHide(item)}
              >
                {#if item.hidden}
                  <!-- Closed eye (red) -->
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.418 0-8.19-2.865-9.543-7  .563-1.792 1.597-3.365 2.929-4.582M6.24 6.24c1.843-1.207 4.034-1.957 6.498-1.957 4.418 0 8.19 2.865 9.543 7-.27.859-.607 1.686-1.005 2.472M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18" />
                  </svg>
                {:else}
                  <!-- Open eye -->
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5s8.268 2.943 9.542 7c-1.274 4.057-5.065 7-9.542 7S3.732 16.057 2.458 12z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    {#if unwatchedCollapsed}
      <!-- Restore tab for Unwatched list (mobile only) -->
      <button
        class="lg:hidden fixed z-50 left-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-l px-1 py-6 shadow flex items-center justify-center"
        style="width: 1.25rem;"
        aria-label="Show Unwatched list"
        on:click={showUnwatched}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <!-- Chevron pointing left (<) -->
          <!-- Chevron pointing right (>) -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {/if}

    <!-- Watched ranking sidebar container -->
    <div
      class="fixed z-40 top-0 bottom-0 right-0 bg-base-200 pl-4 pr-3 py-3 shadow-lg flex flex-col w-full max-w-[20rem] lg:absolute lg:top-0 lg:bottom-0 lg:mt-0 lg:right-4 lg:w-80 transform transition-transform duration-300 overflow-hidden lg:translate-x-0"
      class:translate-x-full={watchedCollapsed}
    >
      <!-- Hide tab (mobile only) -->
      <button
        class="lg:hidden absolute left-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-l px-1 py-6 shadow flex items-center justify-center z-50"
        style="width: 1.25rem;"
        aria-label="Hide Watched list"
        on:click={() => (watchedCollapsed = true)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <!-- Chevron pointing right (>) -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      <div class="flex-1 min-h-0 overflow-hidden pr-1">
        <WatchedRankingSidebar
          list={watchedRank}
      on:update={(e) => {
        // e.detail is an ordered array of anime IDs
        const idOrder = e.detail;
        // Reorder watchedRank to reflect emitted order
        watchedRank = idOrder.map((id) => watchedRank.find((it) => it.id === id)).filter(Boolean);

        // ------------------------------------------------------------------
        // Keep the primary watchList array in sync with the new ranking so
        // future reactive computations (e.g. after marking another show as
        // watched) preserve the user-defined order instead of falling back to
        // the default list ordering.
        // ------------------------------------------------------------------

        watchList = watchList.map((entry) => {
          const idx = idOrder.indexOf(entry.mediaId);
          // Only update rank for entries that are part of the watched list.
          return idx !== -1 ? { ...entry, watchedRank: idx } : entry;
        });

        // Persist watched ranking via dedicated endpoint
        if ($authToken) {
          fetch('/api/list/rank', {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${$authToken}`
            },
            body: JSON.stringify({ season, year, ids: idOrder })
          });
        }
      }}
          on:unwatch={(e) => toggleWatched(e.detail, false)}
        />
      </div>
    </div>

    {#if watchedCollapsed}
      <!-- Restore tab for Watched list -->
      <button
        class="lg:hidden fixed z-50 right-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-r px-1 py-6 shadow flex items-center justify-center"
        style="width: 1.25rem;"
        aria-label="Show Watched list"
        on:click={showWatched}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <!-- Chevron pointing left (<) -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    {/if}

    <!-- Nickname user picker panel (aligned with Watched sidebar) -->
    <div class="absolute top-0 mt-0 w-52 max-h-[80vh] overflow-y-auto bg-base-200/90 rounded-lg shadow-lg p-3 text-sm space-y-1 z-30 hidden lg:block right-[calc(21rem+7px)]">
      <h3 class="font-semibold mb-2">Nicknames from:</h3>

      {#if $nicknameAllUsers.length}
        {#each $nicknameAllUsers as user}
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              class="checkbox checkbox-xs"
              checked={$nicknameSelected.has(user)}
              on:change={() => toggleNicknameUser(user)}
            />
            {user}
          </label>
        {/each}
      {:else}
        <p class="italic opacity-60">No other users yet</p>
      {/if}
    </div>
  </div> <!-- end flex container -->

  {#if showModal && selected}
    <dialog open class="modal">
      <div class="modal-box w-full max-w-3xl">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" on:click={() => (showModal = false)}>✕</button>
        {#key $options.titleLanguage + '-' + selected.id}
        <h3 class="font-bold text-lg mb-2 flex flex-wrap items-baseline gap-1" data-lang={$options.titleLanguage}>
          {selected.customName || getDisplayTitle(selected)}
          {#if myRank != null}
            <span class="text-base font-normal opacity-70">(#{myRank})</span>
          {/if}
        </h3>
        {/key}
        {#if selected.customName}
          <p class="mb-4 text-sm text-base-content/70">
            {getBaseTitle(selected)}
          </p>
        {/if}

        {#if nicknameList.length}
          <div class="mb-6">
            <h4 class="font-semibold mb-1 text-sm">Other users' nicknames:</h4>
            <ul class="list-disc list-inside space-y-1 text-sm">
              {#each nicknameList.filter(n => $nicknameSelected.has(n.userName) && n.userName !== $activeUserName) as n}
                <li>
                  <span class="font-medium">{n.userName}</span>:
                  {#if n.nickname}
                    {` ${n.nickname}`} {#if n.rank != null}(<span class="opacity-70">#{n.rank}</span>){/if}
                  {:else}
                    {#if n.rank != null}
                      (<span class="opacity-70">#{n.rank}</span>)
                    {/if}
                  {/if}
                </li>
              {:else}
                <li class="italic opacity-60">None selected</li>
              {/each}
            </ul>
          </div>
        {/if}
        <img src={selected.coverImage?.extraLarge ?? selected.coverImage?.large ?? selected.coverImage?.medium} alt={selected.title} class="w-56 mx-auto mb-6" />
        <div class="modal-action relative flex justify-center">
          <button class="btn btn-secondary absolute left-0" on:click={hideSelectedSeries}>
            <span class="flex flex-col items-center leading-tight">
              <span>Hide Series</span>
              <span class="text-xs opacity-70">(Unwatched)</span>
            </span>
          </button>
          <button class="btn btn-primary" on:click={markWatched}>Mark as watched</button>
        </div>
      </div>
    </dialog>
  {/if}

<!-- Nickname panel moved further down so its absolute positioning lines up
     with the Watched sidebar (they share the same relative offset based on
     DOM order). -->
</main>

<style>
  /* Ensure extremely long words wrap while still preferring spaces */
  .force-wrap {
    overflow-wrap: anywhere; /* allows break inside long words only if needed */
  }
</style>
