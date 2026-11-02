"""One-off triage of backend/data/recordings: keep the real clinic footage, archive the rest.

Why this exists
---------------
The recordings tree had accumulated 76 metadata rows for 49 actual videos, of which only
about 51 minutes across two days is genuine Masoud-clinic capture. Everything else is one
of: a session that never uploaded a byte, a video file replayed through Live mode while
session recording was on (saved as a fresh "camera" recording, indistinguishable in
metadata from a real capture), a fragment already superseded by a stitched joined.webm, or
a two-second stub. The source picker showed them all in one flat list.

How a replay is told apart from a real capture
----------------------------------------------
The clinic's endoscope burns "Sex / Age / D.O.B. / DD/MM/YYYY / HH:MM:SS" into the top-left
of every frame it outputs. Replaying an old recording re-records that stamp, so the burnt-in
date disagrees with the date the file was written. That disagreement is the signal, and it
is the ONLY reliable one: frame-level content matching cannot do this on its own, because
endoscopy frames correlate ~0.95 with each other regardless of patient.

The stamps in OSD below were read by eye off a contact sheet of every clip, cross-checked
against temporal frame alignment (64x64 grey at 2fps, best mean-correlation over all
offsets; true duplicates scored 0.98-1.00, unrelated footage never above ~0.96). They are
data, not something to re-derive -- OCR on an interlaced PAL overlay is not worth the
dependency.

Nothing is deleted. About 100 rows in feedback/manifest.csv carry a recording_id pointing
into the archived set; the flagged frames and already-cut review clips live under
feedback/cases/ and survive either way, but a hard delete would permanently break the link
back to the source video. Archived files move to backend/data/recordings_archive/, which is
outside DATA_DIR, so list_recordings stops seeing them with no backend change at all.

Usage:  python3 backend/scripts/triage_recordings.py           # dry run, prints the table
        python3 backend/scripts/triage_recordings.py --apply   # actually move files
"""

import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data"
REC = ROOT / "recordings"
ARCHIVE = ROOT / "recordings_archive"
INDEX = ARCHIVE / "INDEX.tsv"

MIN_KEEP_SECONDS = 60

# Burnt-in endoscope date per recording, read off the video itself.
#   "YYYY-MM-DD" -- the stamp says this day
#   None         -- no endoscope overlay at all, so it never came off the clinic scope
# A stamp that disagrees with the day the file was written is a replay.
OSD = {
    ("8a1f1546", "0e8c10e15f7d"): None,          # re-recording of demos/test_polyp_seq2.mp4
    ("a40a4037", "c9a4373b2b06"): None,          # grey test card
    ("c7043a0e", "c1e2c0ffe68c"): None,          # laptop webcam, a dark room
    ("deb1a279", "f47a89a97084"): None,          # laptop webcam
    # The 1352x1080 set: no overlay, and frame-identical to each other across four
    # different days and three different logins. One file, replayed over and over.
    ("4d3251dd", "f8eca056e539"): None,
    ("e7f3566b", "db44a72e919c"): None,
    ("40d23905", "6628d531f3cc"): None,
    ("81f8e027", "ee5aa0b018a1"): None,
    ("fc638a06", "791f05e682b8"): None,
    ("d2b83023", "be91de163993"): None,
    ("1166a749", "68ea67154887"): None,
    ("22cba229", "066171e19a7d"): None,
    ("4342c978", "ccf4ec6f5f4d"): None,
    # 26 Aug 2026, clinic day one (recorded under the `fati` login).
    ("45bc585b", "67be2832e6e2"): "2026-08-26",
    ("2e41cad2", "9789dc0c157d"): "2026-08-26",
    ("9b26a818", "153ffe872dfe"): "2026-08-26",
    ("c4f16f02", "bd8538def4a0"): "2026-08-26",
    ("c4f16f02", "27d2c509a844"): "2026-08-26",
    # 30 Sep 2026, clinic day two.
    ("7fa0f49b", "d194981006ab"): "2026-09-30",
    ("7fa0f49b", "257d4a2a6051"): "2026-09-30",
    ("7fa0f49b", "4389c9740016"): "2026-09-30",
    ("7fa0f49b", "21411c298abf"): "2026-09-30",
    ("7fa0f49b", "47090b0abb4a"): "2026-09-30",
    ("7fa0f49b", "ecab9324c99e"): "2026-09-30",
    ("7fa0f49b", "af478f38c20b"): "2026-09-30",
    ("7fa0f49b", "joined"):       "2026-09-30",
    ("cd369d2b", "bdfc865003cc"): "2026-09-30",
    ("ac52d12a", "eaf375d6194c"): "2026-09-30",
    ("ac52d12a", "joined"):       "2026-09-30",
    ("bbfe0b1c", "9ed106f58cbc"): "2026-09-30",
    ("bbfe0b1c", "6af2a0e607cd"): "2026-09-30",
    ("bbfe0b1c", "3a056c80f7da"): "2026-09-30",
    ("bbfe0b1c", "2fbb943b9efa"): "2026-09-30",
    ("bbfe0b1c", "joined"):       "2026-09-30",
    ("dcafb87f", "d3cb46d6ae07"): "2026-09-30",
    ("dcafb87f", "2e9bf029b316"): "2026-09-30",
    ("dcafb87f", "2eb287f56688"): "2026-09-30",
    ("dcafb87f", "9106b5a9608a"): "2026-09-30",
    ("dcafb87f", "7883d499c7b8"): "2026-09-30",
    ("dcafb87f", "joined"):       "2026-09-30",
    # Replays: written long after the day their overlay claims.
    ("4d0e883e", "f43c563df369"): "2026-08-26",   # written 30 Sep
    ("bf0eebbc", "0b72af9aab95"): "2026-08-26",   # written 5 Oct
    ("bf0eebbc", "722d22b52f65"): "2026-08-26",   # written 5 Oct
    ("41c1e7a5", "b5ad9ed0ca52"): "2026-08-26",   # written 7 Oct
    ("41c1e7a5", "ec9ff5e938fa"): "2026-08-26",   # written 7 Oct
    ("41c1e7a5", "joined"):       "2026-08-26",   # written 7 Oct
    ("ce0027ba", "9966cc013649"): "2026-09-30",   # written 8 Oct
    ("ed5c88ea", "230797f693c5"): "2026-09-30",   # written 8 Oct
    ("ed5c88ea", "b5797b24f39f"): "2026-09-30",   # written 8 Oct
    ("ed5c88ea", "198772fba0b9"): "2026-09-30",   # written 8 Oct
    ("ed5c88ea", "joined"):       "2026-09-30",   # written 8 Oct
}

CLINIC = "masoud"


def real_seconds(path: Path) -> float:
    """Length of the actual video, from the last packet timestamp.

    Not meta["duration_ms"]: that is wall clock measured by the browser and counts the
    paused out-of-body stretches, so it overstates several of these by ~10%.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True).stdout
    best = 0.0
    for line in out.splitlines():
        try:
            best = max(best, float(line.strip().rstrip(",")))
        except ValueError:
            pass
    return best


def main(apply: bool) -> int:
    metas = []
    for meta_file in sorted(REC.glob("*/*.json")):
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        video = meta_file.with_suffix(meta.get("ext", ".webm"))
        metas.append((meta_file, video, meta))

    # Every id that some joined.webm already contains. Keyed on the bare id because
    # ac52d12a/joined pulls one of its parts from a different case directory.
    superseded = set()
    for _, _, meta in metas:
        for part in meta.get("joined_from") or []:
            superseded.add(part)

    unknown = [
        (m["case_id"], m["id"]) for _, v, m in metas
        if v.exists() and v.stat().st_size > 0 and (m["case_id"], m["id"]) not in OSD
    ]
    if unknown:
        print("These have video but no verified overlay reading -- check them by eye first:")
        for row in unknown:
            print("  ", row)
        return 1

    keep, archive = [], []
    for meta_file, video, meta in metas:
        key = (meta["case_id"], meta["id"])
        size = video.stat().st_size if video.exists() else 0
        secs = real_seconds(video) if size else 0.0
        written = datetime.fromtimestamp(meta["started_at"]).strftime("%Y-%m-%d")
        stamp = OSD.get(key, "?")

        if size == 0:
            reason = "empty-no-video-data"
        elif stamp is None:
            reason = "not-clinic-source"
        elif stamp != written:
            reason = "replay-of-" + stamp
        elif meta["id"] in superseded:
            reason = "superseded-by-joined"
        elif secs < MIN_KEEP_SECONDS:
            reason = "under-%ds" % MIN_KEEP_SECONDS
        else:
            reason = None

        row = (meta_file, video, meta, stamp, written, secs, size, reason)
        (archive if reason else keep).append(row)

    width = max(len(r[7] or "") for r in archive) if archive else 0
    print("KEEP (%d)" % len(keep))
    print("  %-10s %-13s %-14s %-9s %8s %9s" % ("case", "id", "clinic day", "user", "length", "size"))
    for _, _, meta, stamp, _, secs, size, _ in sorted(keep, key=lambda r: (r[3], r[2]["started_at"])):
        print("  %-10s %-13s %-14s %-9s %6.0fs %7.1f MB"
              % (meta["case_id"], meta["id"], stamp, meta["user"], secs, size / 1e6))

    print()
    print("ARCHIVE (%d)" % len(archive))
    for _, _, meta, stamp, written, secs, size, reason in sorted(archive, key=lambda r: (r[7], r[2]["started_at"])):
        print("  %-*s  %-10s %-13s written %s  overlay %-10s %6.0fs %7.1f MB"
              % (width, reason, meta["case_id"], meta["id"], written, stamp, secs, size / 1e6))

    print()
    print("keeping %.0f MB in %d files; archiving %.0f MB in %d files"
          % (sum(r[6] for r in keep) / 1e6, len(keep),
             sum(r[6] for r in archive) / 1e6, len(archive)))

    if not apply:
        print("\ndry run -- pass --apply to move files")
        return 0

    ARCHIVE.mkdir(parents=True, exist_ok=True)
    new_index = not INDEX.exists()
    with INDEX.open("a", encoding="utf-8") as index:
        if new_index:
            index.write("case\tid\tuser\treason\toverlay_date\twritten_date\t"
                        "real_seconds\tbytes\toriginal_path\n")
        for meta_file, video, meta, stamp, written, secs, size, reason in archive:
            dest = ARCHIVE / meta["case_id"]
            dest.mkdir(parents=True, exist_ok=True)
            index.write("%s\t%s\t%s\t%s\t%s\t%s\t%.1f\t%d\t%s\n"
                        % (meta["case_id"], meta["id"], meta["user"], reason,
                           stamp, written, secs, size,
                           meta_file.relative_to(ROOT).as_posix()))
            if video.exists():
                shutil.move(str(video), str(dest / video.name))
            shutil.move(str(meta_file), str(dest / meta_file.name))

    # Stamp the survivors so the picker can group by clinic day without guessing from
    # started_at -- which is the server's write time, not when the procedure happened.
    for meta_file, _, meta, stamp, _, _, _, _ in keep:
        meta["clinic_date"] = stamp
        meta["clinic"] = CLINIC
        tmp = meta_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        tmp.replace(meta_file)

    # A case directory holding nothing but archived recordings is just noise now.
    for case_dir in sorted(REC.glob("*")):
        if case_dir.is_dir() and not any(case_dir.iterdir()):
            case_dir.rmdir()

    print("\nmoved %d files to %s" % (len(archive), ARCHIVE))
    return 0


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
