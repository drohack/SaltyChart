"""
How well does font subsetting hold up across real releases?

The player hands libass only the fonts an ASS script *names*, rather than every
attachment the MKV carries — one measured episode ships 39 attachments / 28 MB
of which the script names three / 0.7 MB, and libass ingests everything it is
given before it draws anything.

Matching is by attachment *filename*, which is a heuristic: a file called
`f1.ttf` can contain "Helvetica Neue". So the number that matters is not the
saving, it is **named-but-unmatched** — a font the script asked for that no
filename accounted for. Those are covered at runtime by a background top-up
(`renderer.addFonts`), and this measures how often that safety net is load
bearing.

Mirrors `tools/check_match_corpus.py`: real library data, no fixtures.

Usage:
  py -3.13 -u tools/check_font_corpus.py [-u USER -p PASS] [--season SUMMER --year 2026]
                                         [--limit 20] [--backend http://localhost:3000]
"""
import argparse
import re
import sys
import urllib.parse
from datetime import date

import requests


def norm(s: str) -> str:
    """Same normalisation as fontsFor() in frontend/src/lib/jellyfinPrewarm.ts."""
    return re.sub(r"[^a-z0-9]", "", s.strip().lstrip("@").lower())


def named_fonts(ass: str) -> set[str]:
    names = set(re.findall(r"^Style:\s*[^,]+,\s*([^,]+),", ass, re.M))
    names |= set(re.findall(r"\\fn([^\\}]+)", ass))
    return {n for n in (norm(x) for x in names) if n}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--backend", default="http://localhost:3000")
    p.add_argument("-u", "--username", default="jf_test_fixture")
    p.add_argument("-p", "--password", default="jf_pw_123")
    p.add_argument("--season")
    p.add_argument("--year", type=int)
    p.add_argument("--limit", type=int, default=20, help="episodes to inspect")
    args = p.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    backend = args.backend.rstrip("/")
    today = date.today()
    season = args.season or ("WINTER", "SPRING", "SUMMER", "FALL")[(today.month - 1) // 3]
    year = args.year or today.year

    requests.post(f"{backend}/api/auth/signup",
                  json={"username": args.username, "password": args.password}, timeout=10)
    r = requests.post(f"{backend}/api/auth/login",
                      json={"username": args.username, "password": args.password}, timeout=10)
    if r.status_code != 200:
        print(f"Done: could not log in ({r.status_code})", flush=True)
        return 1
    auth = {"Authorization": f"Bearer {r.json()['token']}"}
    token = r.json()["token"]

    shows = requests.get(f"{backend}/api/anime?season={season}&year={year}&format=TV",
                         timeout=180).json()
    print(f"-- {season} {year}: {len(shows)} entries, inspecting up to {args.limit} --",
          flush=True)

    checked = 0
    tot_named = tot_unmatched = 0
    tot_all_bytes = tot_used_bytes = 0
    worst: list[tuple[str, list[str]]] = []

    for i, show in enumerate(shows, 1):
        if checked >= args.limit:
            break
        titles = [t for t in (show.get("title") or {}).values() if t][:10]
        if not titles:
            continue
        label = titles[0][:34]
        try:
            av = requests.post(f"{backend}/api/jellyfin/availability", headers=auth,
                               json={"mediaId": show["id"], "titles": titles}, timeout=90).json()
        except requests.RequestException as e:
            print(f"[{i}/{len(shows)}] {label}: availability failed ({e})", flush=True)
            continue
        if not av.get("available") or not av.get("itemId"):
            continue

        iid, msid = av["itemId"], av["mediaSourceId"]
        pb = requests.get(f"{backend}/api/jellyfin/playback/{iid}"
                          f"?mediaSourceId={urllib.parse.quote(msid)}",
                          headers=auth, timeout=60).json()
        ass_tracks = [s for s in pb.get("subtitles", [])
                      if "ass" in (s.get("codec") or "").lower()]
        fonts = [a for a in pb.get("attachments", [])
                 if re.search(r"font|otf|ttf", f"{a.get('mimeType')} {a.get('fileName')}", re.I)]
        if not ass_tracks or not fonts:
            print(f"[{i}/{len(shows)}] {label}: no ASS track or no fonts — skipped", flush=True)
            continue

        track = next((s for s in ass_tracks if s.get("isDefault")), ass_tracks[0])
        checked += 1
        print(f"[{i}/{len(shows)}] {label}: reading ASS track {track['index']} "
              f"({checked}/{args.limit})", flush=True)
        try:
            body = requests.get(f"{backend}/api/jellyfin/subtitles", timeout=120, params={
                "itemId": iid, "mediaSourceId": msid, "index": track["index"],
                "format": "ass", "token": token}).content.decode("utf-8", "replace")
        except requests.RequestException as e:
            print(f"[{i}/{len(shows)}] {label}: ass fetch failed ({e})", flush=True)
            continue

        # Mirror fontsFor() in frontend/src/lib/jellyfinPrewarm.ts *including its
        # fallbacks*, or the numbers describe a program we don't ship.
        wanted = named_fonts(body)
        stems = {a["fileName"]: norm(re.sub(r"\.[^.]+$", "", a["fileName"])) for a in fonts}
        all_files = set(stems)
        def placed_by(w: str) -> set[str]:
            """Same exact → prefix → loose tiering as fontsFor()."""
            exact = {f for f, st in stems.items() if st == w}
            if exact:
                return exact
            prefix = {f for f, st in stems.items() if st.startswith(w) or w.startswith(st)}
            if prefix:
                return prefix
            return {f for f, st in stems.items() if w in st or st in w}

        if not wanted:
            matched_files, deferred_files, mode = all_files, set(), "all (script names nothing)"
        else:
            matched_files, unplaced = set(), []
            for w in wanted:
                hits = placed_by(w)
                if not hits:
                    unplaced.append(w)
                matched_files |= hits
            if not matched_files:
                matched_files, deferred_files = all_files, set()
                mode = "all (no name matched a file)"
            else:
                deferred_files = (all_files - matched_files) if unplaced else set()
                mode = "subset + top-up" if deferred_files else "subset"
        unmatched_names = sorted(w for w in wanted if not placed_by(w)) if wanted else []

        # Byte cost of the whole pack vs. what we would actually send up front.
        all_b = used_b = defer_b = 0
        for a in fonts:
            n = int(requests.head(f"{backend}/api/jellyfin/attachments", timeout=60, params={
                "itemId": iid, "mediaSourceId": msid, "index": a["index"], "token": token},
                allow_redirects=True).headers.get("Content-Length") or 0)
            if not n:  # HEAD not supported by the proxy → fall back to a GET
                n = len(requests.get(f"{backend}/api/jellyfin/attachments", timeout=90, params={
                    "itemId": iid, "mediaSourceId": msid, "index": a["index"],
                    "token": token}).content)
            all_b += n
            if a["fileName"] in matched_files:
                used_b += n
            elif a["fileName"] in deferred_files:
                defer_b += n

        tot_named += len(wanted)
        tot_unmatched += len(unmatched_names)
        tot_all_bytes += all_b
        tot_used_bytes += used_b
        if unmatched_names:
            worst.append((label, unmatched_names))

        print(f"    names {len(wanted)} | {len(fonts)} attached ({all_b/1048576:.1f} MB) "
              f"| up front {len(matched_files)} ({used_b/1048576:.1f} MB) [{mode}]"
              + (f" | top-up {len(deferred_files)} ({defer_b/1048576:.1f} MB)"
                 if deferred_files else "")
              + (f" | unmatched {unmatched_names[:3]}" if unmatched_names else ""),
              flush=True)

    if not checked:
        print("Done: no ASS releases with fonts found in this season", flush=True)
        return 0

    pct = 100 * tot_unmatched / max(tot_named, 1)
    saved = 100 * (1 - tot_used_bytes / max(tot_all_bytes, 1))
    print("\n=== summary ===", flush=True)
    print(f"episodes inspected   : {checked}")
    print(f"fonts named          : {tot_named}")
    print(f"named but unmatched  : {tot_unmatched} ({pct:.1f}%)  <- covered by the top-up")
    print(f"font payload         : {tot_all_bytes/1048576:.1f} MB -> "
          f"{tot_used_bytes/1048576:.1f} MB ({saved:.0f}% less)")
    for label, names in worst[:5]:
        print(f"   unmatched in {label}: {names[:4]}")
    print(f"\nDone: {checked} episodes, {tot_unmatched}/{tot_named} named fonts unmatched, "
          f"{saved:.0f}% less font data", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.RequestException as e:
        print(f"Done: backend unreachable — {e}", flush=True)
        sys.exit(1)
