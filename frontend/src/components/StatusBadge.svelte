<script lang="ts">
  /**
   * One entry's status: colour = the result, words = what happened. The full
   * sentence (and any second problem) is the tooltip, and the pages also print
   * it beside the badge - a reason you have to hover for is a hidden reason.
   */
  import { LEVEL, codeLabel, type EntryStatus } from '../lib/entryStatus';

  export let status: EntryStatus;

  $: tip = [status.text, ...(status.also ?? []).map((a) => a.text)].filter(Boolean).join(' - also: ');
</script>

<span
  class="badge badge-sm whitespace-nowrap {LEVEL[status.level].badge}"
  data-level={status.level}
  data-code={status.code}
  title={tip}
>{codeLabel(status.code)}</span>
