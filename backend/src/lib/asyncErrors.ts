/**
 * Make Express 4 send a rejected async handler to the error handler.
 *
 * Express 4 calls a route handler and ignores what it returns, so a promise
 * that rejects - a `null` in a request body reaching `.mediaId`, a non-string
 * password reaching bcrypt, Prisma throwing outside a try - is never answered.
 * The client waits for ever and `process.on('unhandledRejection')` logs it
 * after the fact. Reproduced 2026-10-13: `PUT /api/list` with `items: [null]`
 * hung until the client gave up.
 *
 * Express 5 does exactly this natively; this is the same behaviour, applied
 * once at the layer every handler runs through, rather than a try/catch or a
 * wrapper in each of ~80 routes (several had none). Import it before any
 * router is created. Paired with the final error handler in `index.ts`, which
 * answers in the usual `{ error, code }` shape.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Layer = require('express/lib/router/layer');

const original = Layer.prototype.handle_request;
if (!original.__forwardsRejections) {
  const patched = function handle(this: any, req: any, res: any, next: (err?: any) => void) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // an error handler - Express skips these here
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.then(undefined, next);
    } catch (err) {
      next(err);
    }
  };
  (patched as any).__forwardsRejections = true;
  Layer.prototype.handle_request = patched;
}

export {};
