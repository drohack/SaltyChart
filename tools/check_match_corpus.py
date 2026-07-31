"""
Match-quality corpus check (diagnostic, NOT part of run_all.py).

Runs every entry of a season through /api/jellyfin/availability and reports how
many resolved, and by which tier. Results depend on what is actually in the
library, so this can never gate a deploy — but it is how the id-vs-title
confidence numbers were measured, and it is the fastest way to spot a matcher
regression against real data.

⚠ Not free, and not to be run in a loop. Every entry is a real
`/api/jellyfin/availability` call, and each match makes Jellyfin resolve the
series and list its episodes — a full season is ~52 of those. Run repeatedly
alongside the rest of the suite, this was a measurable share of the API load
that drove the Jellyfin server process to ~800% CPU. Once per matcher change is
the intended cadence, the same rule `bench_player.py` carries.

Usage:
  py -3.13 -u tools/check_match_corpus.py SUMMER 2026 [--backend http://localhost:3000]
"""
import argparse
import json
import sys
import urllib.error
import urllib.request


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("season")
    p.add_argument("year", type=int)
    p.add_argument("--backend", default="http://localhost:3000")
    p.add_argument("--user", default="plex_test_fixture")
    p.add_argument("--password", default="plex_pw_123")
    args = p.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    backend = args.backend.rstrip("/")

    def post(path, body, token=None, timeout=90):
        req = urllib.request.Request(
            backend + path, data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json",
                     **({"Authorization": f"Bearer {token}"} if token else {})})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    try:
        token = post("/api/auth/login", {"username": args.user, "password": args.password})["token"]
    except urllib.error.HTTPError:
        token = post("/api/auth/signup", {"username": args.user, "password": args.password})["token"]

    url = f"{backend}/api/anime?season={args.season}&year={args.year}&format=TV"
    with urllib.request.urlopen(url, timeout=180) as r:
        shows = json.loads(r.read())
    print(f"{args.season} {args.year}: {len(shows)} entries", flush=True)

    by_id = by_title = missing = unknown = 0
    rows = []
    for i, s in enumerate(shows, 1):
        titles = [t for t in (s.get("title") or {}).values() if t][:10]
        try:
            av = post("/api/jellyfin/availability",
                      {"mediaId": s["id"], "titles": titles}, token)
        except Exception as e:
            print(f"  [{i}/{len(shows)}] request failed: {e}", flush=True)
            unknown += 1
            continue
        if av.get("unknown"):
            unknown += 1
            state = "unknown"
        elif av.get("available"):
            state = av.get("matchedBy", "?")
            if state == "id":
                by_id += 1
            else:
                by_title += 1
        else:
            missing += 1
            state = "missing"
        rows.append((state, titles[0][:44], av.get("libraryTitle") or ""))
        print(f"  [{i}/{len(shows)}] {state:8} {titles[0][:44]}", flush=True)

    total = len(shows)
    print(f"\n  id-confirmed : {by_id}/{total}")
    print(f"  title-only   : {by_title}/{total}   <- unconfirmed; shown but marked")
    print(f"  not in library: {missing}/{total}")
    print(f"  inconclusive : {unknown}/{total}")
    if by_title:
        print("\n  title-only matches to eyeball:")
        for state, anilist, lib in rows:
            if state == "title":
                print(f"     {anilist!r:<48} -> {lib!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
