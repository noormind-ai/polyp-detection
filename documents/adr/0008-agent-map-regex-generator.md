# Agent code map: regex generator, not tree-sitter or an MCP server

## Status
Resolved 2026-11-02.

## Problem / Context

Debugging or modifying this repo from an AI assistant was expensive: no local
checkout existed until this session (code lived only on `noormind-iran`,
edited over SSH), so every "where is X" question cost a round trip. Even with
a local clone now in place, a ~100-file repo split across Python (FastAPI
backend) and TypeScript (Next.js frontend) still costs real tokens to
re-locate the same handful of routes and components every session.

A file:line index (`documents/AGENT_MAP.md`) fixes the lookup cost directly —
but a hand-maintained index goes stale the first time a route is added and
nobody remembers to edit it, which recreates the same problem one level up.
So the index itself needs to be produced by something, not typed by hand.

## Prior Work / Literature

| source | claim | code available? | verdict |
|---|---|---|---|
| Aider repo-map (`aider.chat/2023/10/22/repomap.html`) | tree-sitter + PageRank repo map outperforms sending raw code for agent context; replaced aider's original ctags-based map | yes, in `aider-chat` | informs the choice, not adopted directly |
| `aider.chat/docs/ctags.html` | ctags was aider's first approach to this, since dropped | n/a | ctags judged obsolete for this purpose by its own original adopter |
| `hsnacar/code-atlas` (GitHub) | generates an `AGENT_MAP.md` via AST parsers, claims 90-95% token reduction | yes | only parses TypeScript and Go — doesn't cover this repo's Python backend at all |
| `mcp-server-tree-sitter` / `RepoMapper` (MCP servers) | expose tree-sitter-based live symbol/dependency queries as MCP tools, no file needed | yes | considered as a no-file alternative, see below |

## Candidates

1. **Hand-maintained markdown** — no tooling, but guaranteed to drift. Rejected outright; this is the problem being solved, not a candidate solution.
2. **Regex-generated markdown** (`documents/generate_agent_map.py`) — walks `backend/`, `frontend/src/`, `inference/`, matches route decorators (`@router.get(...)`) and top-level `def`/`class`/`export`, rewrites a block between two HTML-comment markers in `AGENT_MAP.md`.
3. **Tree-sitter-generated markdown** — same output, parsed with `py-tree-sitter` + a language pack instead of regex. Matches current (2026) community practice.
4. **Tree-sitter MCP server** (e.g. `mcp-server-tree-sitter`) — no committed file; the assistant queries live code structure on demand instead of reading a cached map.

## Attempts

### Regex extraction, by hand over SSH — 2026-11-02
Before writing the generator, the same route/export extraction was done
manually with `grep -n -E` against the live `noormind-iran` checkout: route
decorators, top-level `def`/`class`, `export default function` / `export
const`. It worked cleanly across all ~100 source files with zero misses —
the codebase's style is consistently single-line decorators and single-line
export statements, which is exactly the case plain regex handles correctly.
The edge cases that motivate tree-sitter in general (multi-line signatures,
decorator arguments split across lines) were not observed anywhere in this
repo during that pass.

## Decision

**Candidate 2: a small, dependency-free regex script**, committed as
`documents/generate_agent_map.py`, rewriting the auto-generated block of
`documents/AGENT_MAP.md` between `<!-- AUTO-GENERATED START/END -->` markers.
The hand-written "Subsystems" section above those markers stays manual,
since grouping files by subsystem is a judgment call a script can't make,
and it changes far less often than line numbers do.

Tree-sitter (candidate 3) is the documented 2026 community standard for
exactly this problem, and was deliberately not adopted here: it requires a
new Python dependency (`py-tree-sitter` + a language pack) to buy correct
parsing of multi-line signatures — a case the manual SSH pass found zero
instances of anywhere in this repo. Paying that dependency cost ahead of the
problem it solves actually showing up isn't justified yet. Re-evaluate if the
codebase's style stops being this consistent (e.g. multi-line decorators
start appearing) — that's the actual trigger for upgrading to candidate 3,
not elapsed time.

### Alternatives considered

**Code Atlas / other AST-based `AGENT_MAP.md` generators (part of candidate 3)**
— pros: off-the-shelf, no script to maintain. / cons: only parse TypeScript
and Go; this repo's backend is Python, so the single most useful part of the
map — route paths — would still need a separate, hand-rolled extractor.
Rejected: it doesn't actually remove the custom-code need, just shrinks it
to the half of the repo it doesn't help with.

**ctags** — pros: a real, long-standing, standard tool; supports both
languages here. / cons: produces a flat symbol index with no concept of an
HTTP route path — `@router.post("/login")` reads as an unremarkable function
to ctags, so the thing most worth indexing (URL → handler) isn't extracted at
all. Also explicitly described as superseded by tree-sitter in aider's own
project history. Rejected on both counts.

**Tree-sitter MCP server (candidate 4)** — pros: always live, zero staleness
possible, nothing to regenerate. / cons: it's infrastructure (a server to
install and configure) rather than a file in the repo; a human — or any other
tool — browsing this repo on GitHub would see nothing, losing the part of
the original goal that wanted this visible in the codebase itself, not only
usable by one assistant mid-session. Rejected for now; worth reconsidering if
the regex script's upkeep becomes a real burden.

### Consequences / risks

- **Regex can silently miss a route or export if the style changes** (e.g. a
  decorator argument spanning two lines). -> no detection mechanism for this
  today; the sign to watch for is `AGENT_MAP.md` looking thinner than
  expected after adding something. Upgrading to tree-sitter (candidate 3) is
  the fix if this starts happening.
- **The map can still go stale between script runs** — regenerating isn't
  automatic, it's a command someone has to remember to run. -> mitigated by
  the hand-written Subsystems section carrying most of the day-to-day
  navigation value; the auto section only needs a refresh after a route or
  component is added or removed, not on every commit.
- **Two source-of-truth risk**: `documents/AGENT_MAP.md` (this repo, visible
  to anyone browsing it) and an earlier `polyp-detection-code-map.md` (kept
  in Claude's private memory, built before this repo was cleaned up) now
  overlap. -> the memory copy should be treated as superseded; it has not
  yet been deleted or marked stale.
