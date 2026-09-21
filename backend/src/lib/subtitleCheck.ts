/**
 * What may be WRITTEN from a YouTube-English-CC check.
 *
 * `check_subtitles()` (backend/scripts/translate_stream.py) answers with three
 * values: `true` (a track exists), `false` (YouTube definitively says none),
 * or `null` (it could not find out - an IP block, a timeout, the package
 * missing). Only the first two are verdicts.
 *
 * This exists because the write sites used to be gated on
 * `hasEnglish !== undefined`, and `null` passes that check. A failed check was
 * therefore written as `0` with a fresh `lastEnCheckAt`, trusted for seven
 * days - so one transient IP block sent a video with English captions down the
 * download path for a week. Every write site goes through here.
 */
export function checkVerdict(result: unknown): 0 | 1 | null {
  const v = (result as { hasEnglish?: unknown } | null | undefined)?.hasEnglish;
  return typeof v === 'boolean' ? (v ? 1 : 0) : null;
}
