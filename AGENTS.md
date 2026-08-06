# AGENTS.md

The canonical contributor/agent guide for this repo lives in
[`CLAUDE.md`](./CLAUDE.md). Read that file first.

Two subsystem guides sit beside the code they describe. Claude Code loads them
automatically when the work touches their directory; **if your tool does not do
that, read them yourself before working in either tree:**

- [`backend/CLAUDE.md`](./backend/CLAUDE.md) - the `/api/jellyfin` and
  `/api/translate` route contracts, the Jellyfin SDK packaging traps, and the
  Whisper translation pipeline.
- [`frontend/CLAUDE.md`](./frontend/CLAUDE.md) - the per-surface UI detail:
  Options modal, season toolbar, anime grid, Randomize, the player, Compare.

This stub exists so agents looking for the conventional `AGENTS.md` filename
(Codex, Gemini CLI, etc.) find a pointer to the real guide.
