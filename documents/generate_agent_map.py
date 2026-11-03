#!/usr/bin/env python3
"""Regenerate the auto-generated section of documents/AGENT_MAP.md.

Walks backend/, frontend/src/, and inference/ for route decorators and
top-level definitions/exports, and rewrites the block between the
AUTO-GENERATED markers in AGENT_MAP.md. Everything outside those markers
(the hand-written "Subsystems" notes) is left untouched.

Run after adding/removing a route or a handful of components:

    python documents/generate_agent_map.py
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MAP_PATH = Path(__file__).resolve().parent / "AGENT_MAP.md"
START = "<!-- AUTO-GENERATED START -->"
END = "<!-- AUTO-GENERATED END -->"

ROUTE_RE = re.compile(r'@(?:router|app)\.(get|post|put|delete|websocket)\(\s*["\']([^"\']+)["\']')
PY_DEF_RE = re.compile(r'^(def |class |async def )\s*([A-Za-z_][\w]*)')
TS_EXPORT_RE = re.compile(r'^export (default function|function|const)\s*([A-Za-z_][\w]*)?')

SKIP_DIR_PARTS = {"node_modules", "__pycache__", ".next"}


def iter_files(base: Path, suffixes: set[str]):
    if not base.exists():
        return
    for p in sorted(base.rglob("*")):
        if p.suffix not in suffixes:
            continue
        if SKIP_DIR_PARTS & set(p.parts):
            continue
        if ".bak" in p.name:
            continue
        yield p


def extract_routes(base: Path) -> list[str]:
    out = []
    for f in iter_files(base, {".py"}):
        rel = f.relative_to(REPO_ROOT).as_posix()
        for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            m = ROUTE_RE.search(line)
            if m:
                method, path = m.groups()
                out.append(f"- `{method.upper()} {path}` — `{rel}:{i}`")
    return out


def extract_py_defs(base: Path) -> list[str]:
    out = []
    for f in iter_files(base, {".py"}):
        rel = f.relative_to(REPO_ROOT).as_posix()
        hits = [str(i) for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1)
                if PY_DEF_RE.match(line)]
        if hits:
            out.append(f"- `{rel}` — lines {', '.join(hits)}")
    return out


def extract_ts_exports(base: Path) -> list[str]:
    out = []
    for f in iter_files(base, {".ts", ".tsx"}):
        rel = f.relative_to(REPO_ROOT).as_posix()
        hits = [str(i) for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1)
                if TS_EXPORT_RE.match(line)]
        if hits:
            out.append(f"- `{rel}` — lines {', '.join(hits)}")
    return out


def build() -> str:
    parts = []
    parts.append("### Backend routes\n")
    parts.extend(extract_routes(REPO_ROOT / "backend" / "routes") or ["(none found)"])
    parts.append(f"- `backend/main.py` — see `@app.get(...)` lines directly")

    parts.append("\n### Backend modules (top-level def/class)\n")
    parts.extend(extract_py_defs(REPO_ROOT / "backend") or ["(none found)"])

    parts.append("\n### Frontend exports\n")
    parts.extend(extract_ts_exports(REPO_ROOT / "frontend" / "src") or ["(none found)"])

    parts.append("\n### Inference (separate Modal deploy)\n")
    parts.extend(extract_py_defs(REPO_ROOT / "inference") or ["(none found)"])

    return "\n".join(parts) + "\n"


def main() -> None:
    text = MAP_PATH.read_text(encoding="utf-8")
    start_i = text.index(START) + len(START)
    end_i = text.index(END)
    new_text = text[:start_i] + "\n\n" + build() + "\n" + text[end_i:]
    MAP_PATH.write_text(new_text, encoding="utf-8")
    print(f"Regenerated {MAP_PATH}")


if __name__ == "__main__":
    main()
