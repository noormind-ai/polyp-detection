# Clinical validation panel

An offline panel where clinicians label individual colonoscopy frames, one at a
time and blind, so the polyp model can be measured and fine-tuned at the frame
level. A report only records whether a polyp was found somewhere in a study; it
cannot say whether the model looked in the right place. This closes that gap.
The reasoning behind the sampling, the blinding and the statistics is in
[DESIGN.md](DESIGN.md).

It ships with the polyp app because it exists to improve that model, and the
two already share accounts: a reviewer created here signs in to the app with
the same credentials (`backend/auth.py`, one-directional -- signing up in the
app grants nothing here). It runs as its own service, on its own port, with its
own dependencies.

Live at https://ir.noormind.me/review, on the Iran server only. Patient
material does not leave that box.

## On the server

Code and state are kept in separate directories on purpose:

    ~/noormind/panel-src/clinical-validation/   this directory, a checkout
    ~/noormind/clinical-validation/data/        frames, panel.db, backups
    ~/noormind/clinical-validation/venv/        dependencies

The checkout is a **separate clone** from the app's own working copy at
`~/noormind/polyp-detection`. That is deliberate: the app's checkout gets
branch-switched during deploys and rollbacks, and a `git checkout` or
`git clean` there must never be able to reach a running clinical service or
the annotations it has collected.

To deploy a change:

    cd ~/noormind/panel-src && git pull
    sudo systemctl restart clinical-validation

Accounts and annotations live in `data/`, which no deploy touches.

## What is deliberately not in this repository

- **`data/`** -- the de-identified frames, `panel.db` (reader accounts and every
  annotation) and the nightly backups.
- **`crosswalk.csv`** -- the only mapping from a case label (`C-0137`) back to a
  real study folder. `scripts/build_pool.py` writes it *outside* its `--out`
  directory on purpose, so it never travels with the images. It lives on the
  analyst's Windows machine and nowhere else. On the server that is the point;
  on the analyst's machine it means keep a backup, because without it no
  annotation can ever be traced back to a patient.

## Layout

    app/         FastAPI service and the single-page front end
    scripts/     de-identification, pool construction, import, admin seeding
    deploy/      systemd units and the backup timer
    DESIGN.md    why the panel shows what it shows, and the statistics

## Rebuilding the pool

The pool is derived, not authored. From the machine that holds the original
studies:

    python scripts/build_pool.py --seed 1 --out build --fp-conf 0.30

Same seed, same pool. It reads three things that also live only on that machine
and are not in this repository: the study images, the report-derived labels and
the baseline YOLOv5m predictions (see the argument defaults).
`scripts/verify_deid.py` checks the crop against every frame geometry before
anything is shipped.
