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

Final line is either `Pre-deploy: N/N passed — ready to build` or
`Pre-deploy: FAILED at step X — DO NOT deploy`.

## Individual tests

| File | What it covers | Needs | Duration |
|---|---|---|---|
| `test_season_lookahead.py` | 76-day next-season cutover logic (regression for "X days till" bug) — pure Python, 6 cases | nothing | <1s |
| `test_api_smoke.py` | 13 happy paths: health, auth, list CRUD (PUT/GET/watched/hidden/rank reorder), anime/AniList, anime cache latency, all 4 public-list endpoints, options round-trip, /api/users (Compare username picker) | backend running | ~10s |
| `test_api_negative.py` | 10 error paths/auth gates: signup missing-fields/dup, password reset round-trip, missing/malformed JWT, bad season validation, /public-list nonexistent user, /translate/check shape, /check-batch shape, admin endpoints reject 401/403 | backend running | ~5s |
| `test_jellyfin.py` | `/api/jellyfin` auth + admin gates, `?token=` paths, availability shape incl. `matchedBy`, stream proxy, a manifest credential-leak assertion, and a subtitle fetch; live steps auto-skip when Jellyfin is unconfigured (set on /admin) | backend running | ~5s unconfigured, ~25s live |
| `backend npm run test:unit` | Title/id matching helpers via `node --test` — the Unicode normalisation guards and the known false positive | nothing | ~1s |
| `test_frontend_smoke.py` | Home/Login/SignUp/Randomize/Compare pages render with no console errors, auth-gated routes accessible after signup | backend + frontend | ~20s |
| `test_ui_interactions.py` | 10 user-clickable interactions: login form, search filter, hide 18+, season change, "watched trailer" button, theme dropdown, wheel spin, logout, trailer modal Escape, Compare with 2 users | backend + frontend | ~20s |
| `test_subtitle_paths.py` | Subtitle Paths B/C/D — YouTube English CC, Whisper overlay, CC toggle persistence | backend + frontend + populated SubtitleCache | ~15s |
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

## Output format

All tests emit self-contained progress lines per the global CLAUDE.md
convention. Each line shows overall position so the Claude Code status bar
makes sense in isolation:

```
[parallel 1-7/11] running 7 independent checks concurrently...
[1/11 pre-deploy] PASS — backend tsc (1.8s)
[2/13 API-smoke] POST /api/auth/signup as smoke_test_1781202612885
[2/13 API-smoke] PASS — got JWT token
[1/2 EsQudPqDOQQ] step 3/4: frame 2/7 (13.1s): MATCH (fz=86% sem=86%)
```
