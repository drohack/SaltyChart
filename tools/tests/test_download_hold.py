"""
The production bot-wall hold, on every door that reaches YouTube.

What it guards: after YouTube explicitly challenges or rate-limits the server
(`lastFailKind: 'botwall'` in `AppConfig.subtitleDownloadHealth`):
  - `GET /api/translate/stream` on a cache miss must be REFUSED with the
    friendly message and `holdUntil`, without the daemon being asked to download
    anything, and must record nothing (a refusal is not an attempt);
  - `GET /api/translate/check-batch` must queue no background checks
    (`X-Check-Queue: held`) and write no verdict;
  - `GET /api/translate/check` must answer from cache only (`hasEnglish: null`,
    `holdUntil` present) and write no row.
Without this, every viewer opening a trailer during a block fires one more
request at a blocked IP - the production twin of the hand-retry loop
`tools/yt_guard.py` stops for dev tooling.

How: back up the health row, inject a bot wall "just now", hit each door with a
never-existing video id, assert, restore the row in a `finally`.

Observability note: the check-batch assertions use the `X-Check-Queue` response
header, computed BEFORE the body is sent. When the daemon is down nothing would
be queued anyway (`no-daemon`), so the "no row written" checks would pass
vacuously - the header is what makes them non-vacuous: `held` means the hold
decided, not the daemon's absence.

Needs the dev backend on :3000. Makes NO YouTube request while the guard holds;
if the guard is broken the daemon will try the fake ids and YouTube will answer
"unavailable" - a harmless request or two, which is the point of the rows.

Runs in run_all.py's SEQUENTIAL group: while the injected state is in place,
every concurrent cache miss would be refused, and the before/after counters
would move under concurrent traffic.
"""

import json
import os
import sqlite3
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DB = os.path.join(REPO, "backend", "prisma", "prisma", "data.db")
BASE = os.environ.get("SALTY_BACKEND", "http://localhost:3000")
KEY = "subtitleDownloadHealth"
# Valid 11-char shapes so the routes' format checks pass; never real videos.
FAKE_STREAM = "zzzzzzzzzzz"
FAKE_BATCH = "zzzzzzzzzzy"
FAKE_CHECK = "zzzzzzzzzzx"

fails = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fails
    fails += not ok
    print(f"  {'PASS  ' if ok else 'FAIL: '}{name}{('  - ' + detail) if detail and not ok else ''}", flush=True)


def read_row(c):
    r = c.execute("select value from AppConfig where key=?", (KEY,)).fetchone()
    return r[0] if r else None


def write_row(c, value):
    if value is None:
        c.execute("delete from AppConfig where key=?", (KEY,))
    else:
        c.execute("insert into AppConfig(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (KEY, value))
    c.commit()


def get(url: str, timeout: int = 25):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read().decode("utf-8", "replace")


def sse_events(body: str) -> list:
    return [json.loads(l[6:]) for l in body.splitlines() if l.startswith("data: ")]


def row_exists(c, vid: str) -> bool:
    return c.execute("select 1 from SubtitleCache where videoId=?", (vid,)).fetchone() is not None


print(f"[1/5] backend {BASE} reachable?", flush=True)
urllib.request.urlopen(f"{BASE}/api/health", timeout=5).read()

c = sqlite3.connect(DB)
saved = read_row(c)
for vid in (FAKE_STREAM, FAKE_BATCH, FAKE_CHECK):
    c.execute("delete from SubtitleCache where videoId=?", (vid,))
c.commit()
try:
    h = json.loads(saved) if saved else {}
    before = (h.get("okCount", 0), h.get("failCount", 0))
    h.update({
        "lastFailAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "lastFailReason": "Sign in to confirm you're not a bot (injected by test_download_hold)",
        "lastFailKind": "botwall",
        "consecutiveFailures": max(1, int(h.get("consecutiveFailures", 0) or 0)),
    })
    write_row(c, json.dumps(h))
    print("[2/5] injected a bot wall just now; /stream on an uncached id", flush=True)

    _, _, body = get(f"{BASE}/api/translate/stream?videoId={FAKE_STREAM}")
    events = sse_events(body)
    err = next((e for e in events if "error" in e), None)
    check("stream refused while holding",
          err is not None and "rate-limited" in err["error"] and bool(err.get("holdUntil")),
          f"events={events!r}")
    check("refusal is terminal (done follows)", any(e.get("done") for e in events), f"events={events!r}")

    print("[3/5] /check-batch on an uncached id while holding", flush=True)
    status, hdrs, body = get(f"{BASE}/api/translate/check-batch?videoIds={FAKE_BATCH}")
    queue = hdrs.get("X-Check-Queue") or hdrs.get("x-check-queue")
    check("check-batch queues nothing while holding", status == 200 and queue == "held", f"status={status} X-Check-Queue={queue!r}")
    time.sleep(3)
    check("check-batch wrote no verdict while holding", not row_exists(c, FAKE_BATCH))

    print("[4/5] /check on an uncached id while holding", flush=True)
    status, _, body = get(f"{BASE}/api/translate/check?videoId={FAKE_CHECK}")
    data = json.loads(body) if body else {}
    check("check answers from cache only while holding",
          status == 200 and data.get("hasEnglish") is None and "hasEnglish" in data and bool(data.get("holdUntil")),
          f"status={status} body={data!r}")
    time.sleep(1)
    check("check wrote no row while holding", not row_exists(c, FAKE_CHECK))

    after_h = json.loads(read_row(c) or "{}")
    after = (after_h.get("okCount", 0), after_h.get("failCount", 0))
    check("refusal recorded nothing", after == before, f"before={before} after={after}")
    print("[5/5] restoring the health row", flush=True)
finally:
    write_row(c, saved)
    for vid in (FAKE_STREAM, FAKE_BATCH, FAKE_CHECK):
        c.execute("delete from SubtitleCache where videoId=?", (vid,))
    c.commit()

print(f"Done: {'FAIL' if fails else 'PASS'} - {fails} failing check(s)", flush=True)
sys.exit(1 if fails else 0)
