"""The rot that is detectable without running anything.

Four documents make claims about the code and go stale silently: the mutation
table, `EXPLORATORY.md`, and the three `CLAUDE.md` guides. Each check below
covers one of them; they share this file because they share a property - no
servers, no transcodes, about a second - which is what lets them gate every
push from inside `run_all.py`.

The original one, and still the load-bearing one:

`mutation_audit.py` breaks one invariant at a time by finding an exact string
in a source file and replacing it. When the code moves, that string stops
matching and the row reports `SKIP` - which is easy to miss in a ~90-minute run
and means the invariant has silently stopped being audited.

That is not hypothetical. Batching the availability lookups moved the
`unknown`-never-hides guard into another file, and its row went on pointing at
code that no longer existed. Nothing failed; the row would simply have skipped
forever.

This is the cheap half of that problem, and only the cheap half. It cannot tell
you whether a row's *test* is meaningful - only a real `mutation_audit.py` run
does that, and six rows were once vacuous while every anchor resolved
perfectly. Treat a pass here as "the rows still aim at something", not "the
rows work".

Usage:
  py -3.13 -u tools/tests/test_audit_anchors.py
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))

#: The root guide loads into EVERY session, so its size is a tax on every task
#: whether or not the task touches what it describes. 40,000 is where Claude
#: Code itself starts warning.
#:
#: Two tiers on purpose. This check runs inside `run_all.py`, which is the push
#: gate, so a single legitimate paragraph must never block a deploy - but
#: sustained drift must. The file reached 87,000 characters before anyone
#: noticed, precisely because nothing was watching it.
ROOT_BUDGET_WARN = 40_000
ROOT_BUDGET_FAIL = 45_000

#: Guides that load only when the work touches their directory.
NESTED_GUIDES = ("backend/CLAUDE.md", "frontend/CLAUDE.md")

#: A root pointer stub may keep a rule or two that binds from outside the
#: nested guide's directory. But once it approaches the size of the section it
#: points at, the section was COPIED rather than moved - and two copies of one
#: story drift apart, which is the whole failure this split introduced.
#: Measured right after the split: the largest real stub is ~14% of its target.
STUB_MAX_RATIO = 0.40

#: Basenames of every file in the repo. `rglob` over a node_modules-sized tree
#: is not cheap and four checks want the same answer, so it is computed once.
_KNOWN_FILES: set[str] | None = None


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    try:
        import mutation_audit as ma
    except Exception as exc:  # a broken table is itself a failure
        print(f"[anchors] FAIL - could not import mutation_audit: {exc!r}", flush=True)
        return 1

    rows = ma.MUTATIONS
    print(f"[anchors] checking {len(rows)} mutation row(s)", flush=True)

    # Cache file reads: several rows edit the same file.
    text: dict[str, str] = {}

    def read(rel: str) -> str | None:
        if rel not in text:
            p = ma.REPO / rel
            try:
                text[rel] = p.read_text(encoding="utf-8")
            except OSError:
                return None
        return text[rel]

    stale: list[str] = []
    for i, m in enumerate(rows, 1):
        problems: list[str] = []

        src = read(m.path)
        if src is None:
            problems.append(f"file missing: {m.path}")
        else:
            if m.find not in src:
                problems.append("find")
            for j, (find, _) in enumerate(m.also):
                if find not in src:
                    problems.append(f"also[{j}]")

        for j, (path, find, _) in enumerate(m.extra):
            other = read(path)
            if other is None:
                problems.append(f"extra[{j}] file missing: {path}")
            elif find not in other:
                problems.append(f"extra[{j}]")

        if problems:
            stale.append(f"  [{i}] {m.name}\n      -> {', '.join(problems)}\n      in {m.path}")

    # A stale anchor does NOT short-circuit the rest. Every check below is
    # independent, and returning here hid all of them - which broke the rows
    # whose own test is this file: the audit mutates the text they anchor on,
    # so the anchor check fires first and the row's real assertion never runs.
    # The row then goes red for the wrong reason, which is precisely the
    # failure `check_expect_is_unambiguous` exists to prevent one layer up.
    rc = 0
    if stale:
        print(f"[anchors] FAIL - {len(stale)} row(s) no longer match the source:", flush=True)
        for s in stale:
            print(s, flush=True)
        print("[anchors] Those rows would SKIP, so the invariant is unaudited. "
              "Update the anchor text to wherever the guard now lives.", flush=True)
        rc = 1
    else:
        print(f"Done: all {len(rows)} mutation anchors resolve", flush=True)

    rc = check_flow_labels(ma, rows) or rc
    rc = check_expect_is_unambiguous(ma, rows) or rc
    rc = check_exploratory_charter(ma.REPO) or rc
    return check_guide_pointers(ma.REPO) or rc


def check_flow_labels(ma, rows) -> int:
    """A row's `flows` must name a real, SELECTABLE flow.

    A renamed or un-allowlisted label makes the child exit 2 before running
    anything - which the audit reads as "the test failed", i.e. a catch. The
    row would report green while auditing nothing at all.
    """
    ui = ma.TESTS / "test_ui_interactions.py"
    src = ui.read_text(encoding="utf-8", errors="replace")
    registry = set(re.findall(r'^\s*\("([^"]+)",\s*lambda', src, re.M))
    selectable = set(re.findall(r'"([^"]+)",', src[src.index("SELECTABLE_FLOWS = {"):
                                                  src.index("}", src.index("SELECTABLE_FLOWS = {"))]))
    bad = []
    for i, m in enumerate(rows, 1):
        for f in getattr(m, "flows", ()):
            if f not in registry:
                bad.append(f"[{i}] {m.name} -> flow {f!r} is not in the registry")
            elif f not in selectable:
                bad.append(f"[{i}] {m.name} -> flow {f!r} is not in SELECTABLE_FLOWS")
    if bad:
        print("[anchors] FAIL - mutation rows name flows that cannot run:", flush=True)
        for b in bad:
            print(f"  {b}", flush=True)
        print("[anchors] A bad label makes the child exit before testing, which "
              "the audit scores as a catch - the row would audit nothing.", flush=True)
        return 1
    tagged = sum(1 for m in rows if getattr(m, "flows", ()))
    print(f"Done: {tagged} row(s) name a selectable UI flow, all valid", flush=True)
    return 0


def check_expect_is_unambiguous(ma, rows) -> int:
    """A row's `expect` must not match SEVERAL assertions in its own test.

    The audit proves a row by finding `expect` in the failing output. When the
    same substring is printed by more than one assertion, a mutation caught by
    the WRONG one still scores as a catch - the exact failure the expect rule
    was introduced to stop, sneaking back in through a too-generic string.
    Three rows shared "override did not change the verdict", which that test
    prints from three different checks.

    Zero matches is NOT an error: plenty of messages are f-strings assembled at
    runtime, so they cannot be found in the source.
    """
    bad = []
    for i, m in enumerate(rows, 1):
        target = next((a for a in m.test if str(a).endswith(".py")), None)
        if target is None:
            continue
        try:
            txt = Path(target).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        n = txt.count(m.expect)
        if n > 1:
            bad.append(f"[{i}] {m.name} -> {m.expect!r} matches {n} assertions")
    if bad:
        print("[anchors] FAIL - ambiguous expect string(s):", flush=True)
        for b in bad:
            print(f"  {b}", flush=True)
        print("[anchors] Make it specific enough that only the intended "
              "assertion can produce it.", flush=True)
        return 1
    print("Done: no row's expect can be satisfied by another assertion", flush=True)
    return 0


def _repo_file_names(repo: Path) -> set[str]:
    """Basenames of every file in the repo, computed once and reused."""
    global _KNOWN_FILES
    if _KNOWN_FILES is None:
        _KNOWN_FILES = {p.name for p in repo.rglob("*")
                        if p.is_file() and "node_modules" not in p.parts
                        and ".git" not in p.parts}
    return _KNOWN_FILES


def _stale_file_citations(text: str, repo: Path, label: str) -> tuple[list[str], set[str]]:
    """Files a doc cites that no longer exist, plus line-number references.

    Shared by the charter check and the guide check because both documents earn
    their keep by pointing at real code, and both rot the same two ways: the
    file gets renamed, or the citation pins a line number that moves silently.
    """
    # The leading class excludes a bare extension: prose legitimately discusses
    # `.d.ts` files, and treating that as a citation reported a missing file
    # that was never a path in the first place.
    cite = r"`([A-Za-z0-9_][A-Za-z0-9_/.-]*\.(?:svelte|ts|css|py))"
    known = _repo_file_names(repo)

    def real(ref: str) -> bool:
        return (repo / ref).exists() or ref.split("/")[-1] in known

    problems: list[str] = []
    for path, line in re.findall(cite + r":(\d+)`", text):
        # Only a real file can be a real citation. These docs discuss the
        # anti-pattern by name - "a `file.svelte:36` reference was moved by its
        # own fix" - and flagging the illustration taught nobody anything.
        if real(path):
            problems.append(
                f"{label}line-number reference `{path}:{line}` - cite an identifier "
                f"instead, line numbers move silently"
            )

    cited = set(re.findall(cite + "`", text))
    for ref in sorted(cited):
        if not real(ref):
            problems.append(f"{label}cites `{ref}`, which no longer exists anywhere in the repo")
    return problems, cited


def _sections(text: str) -> dict[str, tuple[int, int]]:
    """`{title: (heading level, size of that section in chars)}`.

    A section runs to the next heading of the SAME level or higher, so it
    includes its own subsections. Stopping at the next heading of any level
    would measure a parent as just its opening paragraph - which made a 13k
    section look like 506 characters and read as a stub.
    """
    lines = text.splitlines(keepends=True)
    heads = [(i, len(m.group(1)), m.group(2))
             for i, l in enumerate(lines)
             for m in [re.match(r"^(#{2,6}) (.+?)\s*$", l)] if m]
    out: dict[str, tuple[int, int]] = {}
    for j, (i, level, title) in enumerate(heads):
        end = len(lines)
        for k, lvl, _ in heads[j + 1:]:
            if lvl <= level:
                end = k
                break
        out[title] = (level, sum(len(x) for x in lines[i:end]))
    return out


def check_guide_pointers(repo: Path) -> int:
    """The three CLAUDE.md guides must not drift apart.

    Splitting the root guide bought every session ~8k tokens and introduced a
    new failure mode in exchange: a rule updated in one file while another goes
    on stating the old behaviour, or a section moved out with no pointer left
    behind, so nobody who needs it ever learns it exists. `CLAUDE.md` opens by
    calling docs drift a real bug - this is the mechanical half of catching it,
    and it costs no servers, so it can sit on the push gate.

    Prose cannot be verified and is not attempted. What can:
      * the root stays inside its size budget (the reason for the split)
      * every nested guide the root cites actually exists
      * every `##` section in a nested guide has a pointer stub in the root
      * a stub stays a stub, rather than growing back into a second copy
      * cited files resolve, and nothing pins a line number
    """
    root_path = repo / "CLAUDE.md"
    if not root_path.exists():
        print("[guides] SKIP - no root CLAUDE.md", flush=True)
        return 0

    root_text = root_path.read_text(encoding="utf-8")
    problems: list[str] = []

    size = len(root_text)
    if size > ROOT_BUDGET_FAIL:
        problems.append(
            f"root CLAUDE.md is {size:,} chars, past the {ROOT_BUDGET_FAIL:,} "
            f"ceiling - move a subsystem section into a nested guide, or raise "
            f"the ceiling deliberately if the content really is cross-cutting"
        )
    elif size > ROOT_BUDGET_WARN:
        print(f"[guides] WARNING - root CLAUDE.md is {size:,} chars, past the "
              f"{ROOT_BUDGET_WARN:,} mark and failing at {ROOT_BUDGET_FAIL:,}. "
              f"Every session pays for this file.", flush=True)

    # Any nested guide the root names must be there. A pointer to a file that
    # does not exist is worse than no pointer: it reads as "documented".
    for ref in sorted(set(re.findall(r"`([A-Za-z0-9_./-]*CLAUDE\.md)`", root_text))):
        if ref != "CLAUDE.md" and not (repo / ref).exists():
            problems.append(f"root points at `{ref}`, which is not in the repo")

    # The root rots the same way its nested guides do, and it is the file every
    # session reads, so it is held to the same standard.
    found, _ = _stale_file_citations(root_text, repo, "CLAUDE.md: ")
    problems += found

    root_sections = _sections(root_text)
    checked = 0

    for rel in NESTED_GUIDES:
        path = repo / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for title, (level, section_size) in _sections(text).items():
            if level != 2:            # only top-level sections need a pointer
                continue
            checked += 1
            if title not in root_sections:
                problems.append(
                    f"{rel} has section '{title}' with no pointer in the root - "
                    f"a reader who needs it will never learn it exists"
                )
                continue
            _, stub_size = root_sections[title]
            if section_size and stub_size > section_size * STUB_MAX_RATIO:
                problems.append(
                    f"'{title}' is {stub_size:,} chars in the root against "
                    f"{section_size:,} in {rel} - that reads as copied rather "
                    f"than moved, and two copies of one story drift apart"
                )
        found, _ = _stale_file_citations(text, repo, f"{rel}: ")
        problems += found

    # Path-scoped rules under `.claude/rules/` are a third home for guidance,
    # with two failure modes the guides don't have.
    rules_dir = repo / ".claude" / "rules"
    rule_files = sorted(rules_dir.glob("*.md")) if rules_dir.is_dir() else []
    for path in rule_files:
        rel = path.relative_to(repo).as_posix()

        # `.claude/*` is gitignored with a per-directory negation for each
        # thing that belongs in the repo. A rule file git ignores is a rule
        # only this machine has - the same trap that would have silently
        # dropped the skills directory, hit a second time when rules arrived.
        if subprocess.run(["git", "check-ignore", "-q", rel], cwd=repo,
                          capture_output=True).returncode == 0:
            problems.append(
                f"{rel} is gitignored, so it would never reach anyone else - "
                f"add a negation for its directory in .gitignore"
            )

        text = path.read_text(encoding="utf-8")
        frontmatter = ""
        if text.startswith("---"):
            end = text.find("\n---", 3)
            if end != -1:
                frontmatter = text[3:end]
        # Without `paths:` a rule loads in EVERY session, which silently undoes
        # the only reason for moving it out of the root.
        if "paths:" not in frontmatter:
            problems.append(
                f"{rel} has no `paths:` frontmatter, so it loads in every "
                f"session - which is the opposite of why it was moved here"
            )

        found, _ = _stale_file_citations(text, repo, f"{rel}: ")
        problems += found

    if problems:
        print(f"[guides] FAIL - {len(problems)} problem(s) across the CLAUDE.md guides:",
              flush=True)
        for p in problems:
            print(f"  {p}", flush=True)
        print("[guides] The split only works while the root stays small and every "
              "moved section is still reachable from it.", flush=True)
        return 1

    print(f"Done: {len(NESTED_GUIDES)} nested guide(s), {checked} section(s) all "
          f"pointed at from the root, {len(rule_files)} path-scoped rule(s) "
          f"({size:,} chars, {root_text.count(chr(10)) + 1} lines)", flush=True)
    return 0


def check_exploratory_charter(repo: Path) -> int:
    """`EXPLORATORY.md` must not rot into misleading instructions.

    It goes stale faster than anything else here, because *fixing* a bug it found
    changes the behaviour it tells the next agent to expect. Within hours of pass
    1 it carried two instructions that would have made the next agent re-file a
    withdrawn finding, plus a `file.svelte:36` reference the fix had already
    moved.

    Only the mechanical half is checkable - prose can't be verified:
      * every cited file path exists
      * no `file.ext:NN` line references, which are the most rot-prone form
        (CLAUDE.md says so explicitly) and rot silently. Cite an identifier.
    """
    doc = repo / "tools" / "tests" / "EXPLORATORY.md"
    if not doc.exists():
        print("[charter] SKIP - tools/tests/EXPLORATORY.md not present", flush=True)
        return 0
    text = doc.read_text(encoding="utf-8")
    problems, cited = _stale_file_citations(text, repo, "")

    if problems:
        print(f"[charter] FAIL - EXPLORATORY.md has {len(problems)} stale reference(s):", flush=True)
        for p in problems:
            print(f"  {p}", flush=True)
        print("[charter] A charter that misdescribes the app sends the next pass "
              "chasing findings that were already fixed.", flush=True)
        return 1

    print(f"Done: EXPLORATORY.md cites {len(cited)} file(s), all resolve, no line refs",
          flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
