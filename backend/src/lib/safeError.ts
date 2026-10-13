/**
 * A loggable description of ANY error, with nothing that could carry a header.
 *
 * `jellyfinErrorInfo` / `sonarrErrorInfo` / `mailErrorInfo` cover the catches
 * that know what they called. This is for the ones that cannot know - the
 * process-wide `unhandledRejection` / `uncaughtException` backstops and broad
 * route catches - where an escaped axios error would otherwise print its whole
 * `config`, request headers included (the Jellyfin `Token="..."` leak). Keeps
 * code, HTTP status, message and the stack frames; never serialises the object.
 */
export function safeErrorText(err: any): string {
  if (err === null || err === undefined || typeof err !== 'object') return String(err);
  const status = err.response?.status;
  const head = [err.name, err.code, status ? `HTTP ${status}` : null, err.message]
    .filter(Boolean)
    .map(String)
    .join(' ');
  // The first stack line repeats name + message; the frames are what matter.
  const frames = typeof err.stack === 'string' ? err.stack.split('\n').slice(1).join('\n') : '';
  return [head || '(error with no message)', frames].filter(Boolean).join('\n');
}
