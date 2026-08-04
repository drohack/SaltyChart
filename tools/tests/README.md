# Regression tests

Pre-deploy smoke + regression tests for SaltyChart. Run these before building
Docker images to catch site-breaking regressions.

Full suite runs in **~45s** without GPU (steps 1-7 run in parallel; steps 8-10
sequentially share the browser). With the burned-in GPU test added: ~105s.

## One-shot pre-deploy

```bash
# 0. Start clean — kill stale ts-node-dev / vite processes from prior sessions
py -3.13 tools/tests/kill_stale.py

# 1. Backend + frontend dev servers (Vite is strictPort=true, always 5173)
cd backend && npm run dev          # terminal 1, port 3000
cd frontend && npm run dev         # terminal 2, port 5173

# 2. Run the full pre-deploy suite (default flags assume :3000 + :5173)
py -3.13 -u tools/tests/run_all.py

# Skip the GPU-heavy burned-in detection test
py -3.13 -u tools/tests/run_all.py --skip-burned-in
```

If frontend fails to start with `Port 5173 is in use`, run `kill_stale.py`
again — `strictPort: true` in `vite.config.ts` prevents falling through to
5174 so we never have to guess which port the test suite should target.

`run_all.py` also runs `cleanup_users.py` at startup: every run signs up fresh
throwaway users (`smoke_test_*`, `ui_test_*`, `fe_smoke_*`, …) and nothing ever
deleted them — ~660 had accumulated, all auto-checked in Randomize's
"Nicknames from" panel like real people. It deletes by known prefixes plus the
10-digit epoch suffix every generated name carries, and never touches the
reused fixtures (`jf_test_fixture`, `player_*_fixture`, `plex_test_fixture`).

Final line is either `Pre-deploy: N/N passed — ready to build` or
`Pre-deploy: FAILED at step X — DO NOT deploy`.

## Individual tests

| File | What it covers | Needs | Duration |
|---|---|---|---|
| `test_season_lookahead.py` | 50-day next-season cutover logic (regression for "X days till" bug, and the 76→50 boundary move) — pure Python, 8 cases | nothing | <1s |
| `test_api_smoke.py` | 13 happy paths: health, auth, list CRUD (PUT/GET/watched/hidden/rank reorder), anime/AniList, anime cache latency, all 4 public-list endpoints, options round-trip, /api/users (Compare username picker) | backend running | ~10s |
| `test_api_negative.py` | 10 error paths/auth gates: signup missing-fields/dup, password reset round-trip, missing/malformed JWT, bad season validation, /public-list nonexistent user, /translate/check shape, /check-batch shape, admin endpoints reject 401/403 | backend running | ~5s |
| `test_jellyfin.py` | 12 steps: `/api/jellyfin` auth + admin gates, `?token=` paths, availability shape incl. `matchedBy` and an id-tier liveness check, stream proxy, a manifest credential-leak assertion, a subtitle fetch, `Cache-Control` on subtitles/attachments, a well-formed WebVTT header, the config keep-on-empty round trip, the admin lookup (a name search offers id-bearing picks; a pasted `tvdb:<held id>` comes back named and cross-walked to TMDB), and the identity-override round trip (wrong id / rejection / unheld film all flip the verdict, Confirm keeps provenance, and the invalidation reaches the persisted blob); live steps auto-skip when Jellyfin is unconfigured (set on /admin) | backend running | ~5s unconfigured, ~90s live |
| `backend npm run test:unit` | Title/id matching helpers via `node --test` — the Unicode normalisation guards and the known false positive | nothing | ~1s |
| `test_frontend_smoke.py` | Home/Login/SignUp/Randomize/Compare pages render with no console errors, auth-gated routes accessible after signup | backend + frontend | ~20s |
| `test_ui_interactions.py` | 24 flows: button-click smoke (login, search, hide 18+, season, watched-trailer, theme, wheel, logout, modal Escape, Compare with 2 users), the exploratory-pass guards (no-results message, zero availability calls + disabled Hide button on an unaired season, check-batch chunking, visible translation errors, phone sidebar collapsed, guest options + Compare's missing-user warning), admin page, unknown-never-hides, share-as-image, progressive loading, three silent-failure paths (unreachable library, hung backend, failed hide write), and the /admin/matching review of a resolver title-text accept | backend + frontend | ~3 min |
| `test_subtitle_paths.py` | Subtitle Paths B/C/D — YouTube English CC, Whisper overlay, CC toggle persistence | backend + frontend + populated SubtitleCache | ~15s |
| `test_player.py` | 10 steps driving the **real Jellyfin player**, which nothing else does: pop-up pre-warm fires and no stream starts early, playback actually advances, exactly one subtitle menu defaulting to plain English, `[`/`]` stepping 0.10 with the control bar hidden, burned-in subtitles verified in the pixels (12 frames sampled with subtitles on and off), the quality menu reaching 480p in one restart, Escape stopping the transcode. Skips when Jellyfin is unconfigured or nothing in the season is in the library | backend + frontend + Jellyfin | ~2 min |
| `test_burned_in_detection.py` | Whisper large-v3 + OCR + sentence-transformers burned-in detection: Eren=yes, Sparks=no | CUDA GPU, backend running | ~60s |

Run any individually with:
```
py -3.13 -u tools/tests/test_api_smoke.py
py -3.13 -u tools/tests/test_frontend_smoke.py --frontend http://localhost:5173
py -3.13 -u tools/tests/test_subtitle_paths.py --frontend http://localhost:5173
py -3.13 -u tools/tests/test_burned_in_detection.py
```

## Test video fixtures

`test_subtitle_paths.py` and `test_burned_in_detection.py` use fixed video IDs
that must exist in `SubtitleCache` with the expected state:

| Video ID | Title | State needed |
|---|---|---|
| `EsQudPqDOQQ` | Eren the Southpaw | Burned-in subs (used by detection test) |
| `7ObipYqbOd8` | Sparks of Tomorrow | YouTube English CC, `hasEnglishSubs=1` |
| `ByOF3FLlAws` | (Tokyo Shinkatsu trailer) | `hasEnglishSubs=0`, cached Whisper segments |

If the local dev DB doesn't have these, populate via the live daemon (open the
trailer in the app once) or copy rows from the prod DB.

## When to run

- **Before every deploy** — `run_all.py` is the gate.
- After any change to `backend/src/routes/*`, `frontend/src/components/AnimeGridTranslate.svelte`,
  `frontend/src/pages/Home.svelte`, `frontend/src/stores/season.ts`, or
  `tools/local_translate.py`.
- After any Whisper / sentence-transformers / Prisma version bump.
- After any change to the SubtitleCache or WatchList schema.

## What this suite cannot catch — `EXPLORATORY.md`

Every check here asks *"does this mechanism work?"* in isolation, from a clean
load, asserted by whoever wrote the feature. That shape can't see state going
stale across a sequence, a control nobody thought to assert on, a console error
where nothing is looking, or a layout that collapses at 390px.

`EXPLORATORY.md` is the charter for an agent driving a real browser as a user.
It is deliberately **not** automated — its output is a findings list, and
anything it finds twice should graduate into this suite with a
`mutation_audit.py` row. Read its *Traps* section before starting; several
plausible-looking "bugs" there are measurement artifacts.

## Output format

All tests emit self-contained progress lines per the global CLAUDE.md
convention. Each line shows overall position so the Claude Code status bar
makes sense in isolation:

```
[parallel 1-7/12] running 7 independent checks concurrently...
[1/12 pre-deploy] PASS — backend tsc (1.8s)
[2/13 API-smoke] POST /api/auth/signup as smoke_test_1781202612885
[2/13 API-smoke] PASS — got JWT token
[1/2 EsQudPqDOQQ] step 3/4: frame 2/7 (13.1s): MATCH (fz=86% sem=86%)
```
