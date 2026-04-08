<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { options, DEFAULT_SUBTITLE_PREFS, type SubtitlePrefs } from '../stores/options';

  const dispatch = createEventDispatcher();

  export let videoId: string | null = null;
  export let subtitlesVisible: boolean = true;

  function toggleVideoSubtitles(visible: boolean) {
    dispatch('toggleVideo', { visible });
    if (videoId) {
      fetch(`/api/translate/dismiss?videoId=${videoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: !visible }),
      }).catch(() => {});
    }
  }

  const FONTS = [
    'Arial',
    'Verdana',
    'Georgia',
    'Courier New',
    'Times New Roman',
    'Trebuchet MS',
    'Comic Sans MS',
  ];

  function hexToRgb(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
  }

  function textBorderStyle(border: string): string {
    if (border === 'light') return 'text-shadow: 1px 1px 1px rgba(0,0,0,0.5), -1px -1px 1px rgba(0,0,0,0.5);';
    if (border === 'medium') return 'text-shadow: 1px 1px 2px rgba(0,0,0,0.8), -1px -1px 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.5);';
    if (border === 'heavy') return 'text-shadow: 2px 2px 4px #000, -2px -2px 4px #000, 0 0 6px rgba(0,0,0,0.9);';
    if (border === 'drop-shadow') return 'text-shadow: 3px 3px 4px rgba(0,0,0,0.9);';
    if (border === 'glow') return 'text-shadow: 0 0 6px rgba(255,255,255,0.8), 0 0 12px rgba(255,255,255,0.4);';
    return '';
  }

  function update(field: keyof SubtitlePrefs, value: any) {
    $options.subtitlePrefs = { ...$options.subtitlePrefs, [field]: value };
    // Trigger reactivity on the parent store
    $options = $options;
  }

  function restoreDefaults() {
    $options.subtitlePrefs = { ...DEFAULT_SUBTITLE_PREFS };
    $options = $options;
  }

  function close() {
    dispatch('close');
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  $: prefs = $options.subtitlePrefs;
  $: previewStyle = `
    font-size: ${prefs.fontSize}px;
    font-family: '${prefs.fontFamily}', sans-serif;
    color: ${prefs.textColor};
    background: rgba(${hexToRgb(prefs.bgColor)}, ${prefs.bgOpacity / 100});
    ${textBorderStyle(prefs.textBorder)}
  `;
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Backdrop -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="fixed inset-0 z-[110]" on:click={close}>
  <!-- Panel -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="absolute right-4 top-14 w-80 bg-base-300 rounded-lg shadow-2xl p-4 z-[111] max-h-[80vh] overflow-y-auto"
    on:click|stopPropagation
  >
    <!-- Header -->
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-bold text-base">Subtitle Settings</h3>
      <button class="btn btn-ghost btn-xs btn-circle" on:click={close}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4">
          <path d="M6.3 17.3a1 1 0 0 0 1.4 0L12 13.4l4.3 4.3a1 1 0 0 0 1.4-1.4L13.4 12l4.3-4.3a1 1 0 0 0-1.4-1.4L12 10.6 7.7 6.3a1 1 0 0 0-1.4 1.4L10.6 12l-4.3 4.3a1 1 0 0 0 0 1.4z"/>
        </svg>
      </button>
    </div>

    <!-- Per-video toggle -->
    <div class="form-control">
      <label class="label cursor-pointer py-1">
        <span class="label-text">This video</span>
        <input type="checkbox" class="toggle toggle-sm toggle-primary"
          checked={subtitlesVisible}
          on:change={(e) => toggleVideoSubtitles(e.currentTarget.checked)} />
      </label>
    </div>

    <!-- Master toggle -->
    <div class="form-control mb-3">
      <label class="label cursor-pointer py-1">
        <span class="label-text">All videos</span>
        <input type="checkbox" class="toggle toggle-sm toggle-primary"
          checked={prefs.enabled}
          on:change={(e) => update('enabled', e.currentTarget.checked)} />
      </label>
    </div>

    <div class="divider my-1"></div>

    <!-- Font size -->
    <div class="form-control mb-2">
      <label class="label py-0.5">
        <span class="label-text text-sm">Font size</span>
        <span class="label-text-alt">{prefs.fontSize}px</span>
      </label>
      <input type="range" class="range range-xs range-primary" min="14" max="60" step="1"
        value={prefs.fontSize}
        on:input={(e) => update('fontSize', parseInt(e.currentTarget.value))} />
    </div>

    <!-- Font family -->
    <div class="form-control mb-2">
      <label class="label py-0.5">
        <span class="label-text text-sm">Font</span>
      </label>
      <select class="select select-bordered select-sm w-full"
        value={prefs.fontFamily}
        on:change={(e) => update('fontFamily', e.currentTarget.value)}>
        {#each FONTS as font}
          <option value={font} style="font-family: '{font}', sans-serif">{font}</option>
        {/each}
      </select>
    </div>

    <!-- Position -->
    <div class="form-control mb-2">
      <label class="label py-0.5">
        <span class="label-text text-sm">Position (from bottom)</span>
        <span class="label-text-alt">{prefs.position}px</span>
      </label>
      <input type="range" class="range range-xs range-primary" min="0" max="500" step="1"
        value={prefs.position}
        on:input={(e) => update('position', parseInt(e.currentTarget.value))} />
    </div>

    <!-- Text color -->
    <div class="form-control mb-2">
      <label class="label py-0.5">
        <span class="label-text text-sm">Text color</span>
        <input type="color" class="w-8 h-6 rounded cursor-pointer border border-base-content/20"
          value={prefs.textColor}
          on:input={(e) => update('textColor', e.currentTarget.value)} />
      </label>
    </div>

    <!-- Background color -->
    <div class="form-control mb-2">
      <label class="label py-0.5">
        <span class="label-text text-sm">Background color</span>
        <input type="color" class="w-8 h-6 rounded cursor-pointer border border-base-content/20"
          value={prefs.bgColor}
          on:input={(e) => update('bgColor', e.currentTarget.value)} />
      </label>
    </div>

    <!-- Background opacity -->
    <div class="form-control mb-2">
      <label class="label py-0.5">
        <span class="label-text text-sm">Background opacity</span>
        <span class="label-text-alt">{prefs.bgOpacity}%</span>
      </label>
      <input type="range" class="range range-xs range-primary" min="0" max="100" step="5"
        value={prefs.bgOpacity}
        on:input={(e) => update('bgOpacity', parseInt(e.currentTarget.value))} />
    </div>

    <!-- Text border -->
    <div class="form-control mb-3">
      <label class="label py-0.5">
        <span class="label-text text-sm">Text outline</span>
      </label>
      <select class="select select-bordered select-sm w-full"
        value={prefs.textBorder}
        on:change={(e) => update('textBorder', e.currentTarget.value)}>
        <option value="none">None</option>
        <option value="light">Light</option>
        <option value="medium">Medium</option>
        <option value="heavy">Heavy</option>
        <option value="drop-shadow">Drop Shadow</option>
        <option value="glow">Glow</option>
      </select>
    </div>

    <div class="divider my-1"></div>

    <!-- Preview -->
    <div class="form-control mb-3">
      <label class="label py-0.5">
        <span class="label-text text-sm">Preview</span>
      </label>
      <div class="bg-base-100 rounded p-3 flex items-center justify-center min-h-[60px]">
        <span class="px-1.5 py-0.5 rounded text-center" style={previewStyle}>
          Sample subtitle text
        </span>
      </div>
    </div>

    <!-- Restore defaults -->
    <button class="btn btn-ghost btn-sm w-full" on:click={restoreDefaults}>
      Restore Defaults
    </button>
  </div>
</div>
