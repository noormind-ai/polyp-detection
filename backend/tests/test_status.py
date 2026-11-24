"""Tests for the /status page's log parsing and state rules.

Run from the repo root:  python -m pytest backend/tests -q
"""
from datetime import datetime, timedelta

from backend.routes import status as st

LOG = """\
2026-11-24 08:30:00,100 INFO    infer — frame 1 | cpu:rtdetr | infer=40ms total=40ms | 0 boxes
2026-11-24 08:31:00,100 WARNING aioice.turn — TURN allocation slow
2026-11-24 08:33:15,000 ERROR   uvicorn.error — Exception in ASGI application
Traceback (most recent call last):
  File "x.py", line 1, in f
RuntimeError: Cannot call "send" once a close message has been sent.
2026-11-24 08:34:26,555 INFO    infer — frame 2 | cpu:rtdetr | infer=38ms total=38ms | 0 boxes
""".splitlines()

NOW = datetime(2026, 11, 24, 8, 35, 0)


def test_parse_attaches_traceback_to_its_entry():
    entries = st.parse_log_lines(LOG)
    assert [e["component"] for e in entries] == ["infer", "aioice.turn", "uvicorn.error", "infer"]
    err = entries[2]
    assert err["level"] == "ERROR"
    assert "RuntimeError: Cannot call" in err["extra"]
    assert err["extra"].startswith("Traceback")


def test_parse_ignores_junk_before_first_entry():
    entries = st.parse_log_lines(["half a cut line", *LOG])
    assert len(entries) == 4


def test_filter_by_level_component_text_and_time():
    entries = st.parse_log_lines(LOG)
    assert len(st.filter_entries(entries, min_level="WARNING")) == 2
    assert len(st.filter_entries(entries, component="infer")) == 2
    # text search reaches into the traceback, not only the first line
    assert len(st.filter_entries(entries, query="close message")) == 1
    assert len(st.filter_entries(entries, since=datetime(2026, 11, 24, 8, 32))) == 2


def test_fresh_error_is_fail_and_counted_per_component():
    s = st.summarize_problems(st.parse_log_lines(LOG), NOW)
    assert s["state"] == "fail"
    assert s["errors"] == {"uvicorn.error": 1}
    assert s["warnings"] == {"aioice.turn": 1}


def test_old_error_is_only_warn():
    s = st.summarize_problems(st.parse_log_lines(LOG), NOW + timedelta(minutes=30))
    assert s["state"] == "warn"


def test_no_problems_is_ok():
    s = st.summarize_problems(st.parse_log_lines(LOG), NOW + timedelta(hours=3))
    assert s["state"] == "ok"
    assert s["errors"] == {}


def test_disk_thresholds():
    assert st.classify_disk(94) == "ok"
    assert st.classify_disk(8) == "warn"
    assert st.classify_disk(1) == "fail"


def test_ago():
    assert st.ago(5) == "5s ago"
    assert st.ago(180) == "3 min ago"
    assert st.ago(3 * 3600 + 120) == "3h 2m ago"


def test_read_log_entries_tail(tmp_path):
    f = tmp_path / "backend.log"
    f.write_text("\n".join(LOG) + "\n", encoding="utf-8")
    assert len(st.read_log_entries(f)) == 4
    assert st.read_log_entries(tmp_path / "missing.log") == []


def test_a_crashing_check_becomes_a_fail_row_not_a_500():
    import asyncio

    def boom(entries):
        raise ValueError("nope")

    row = asyncio.run(st._one("x", "X", boom, []))
    assert row["state"] == "fail"
    assert "ValueError: nope" in row["summary"]
