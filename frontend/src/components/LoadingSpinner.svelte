<script lang="ts">
  export let size: 'xs' | 'sm' | 'md' | 'lg' = 'md';
  // Map size prop to DaisyUI size utility class
  const sizeClass = {
    xs: 'loading-xs',
    sm: 'loading-sm',
    md: 'loading-md',
    lg: 'loading-lg'
  }[size];
</script>

<div class="flex justify-center items-center py-8">
  <span class={`loading loading-spinner ${sizeClass} text-primary`}></span>
</div>
