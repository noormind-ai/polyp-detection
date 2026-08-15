# Offline feedback panel — design

`https://ir.noormind.me/review` · Iran server only · deployed 2026-08-14

---

## 1. Why this exists

Our labels are **per patient**, read out of the colonoscopy report:

> "a 7 mm sessile polyp in the ascending colon"

The model works **per image**. So every number in the evaluation is fitted to a
label that contains no image-level information:

- a study counted **TP** does not mean the model fired on the *right image*
- a study counted **FP** may be a lesion the report never recorded
- a study counted **FN** may be one where the polyp was **never photographed** —
  not a model failure at all

The panel turns those four patient-level cells into per-image questions.

### The threshold today

Two parameters: `conf ≥ 0.70` per image, **and** how many flagged images make a
patient positive. The second is the real decision:

| rule (conf ≥ 0.70) | sens | precision | spec |
| ------------------ | ---: | --------: | ---: |
| ≥1 flagged image   | **90.3%** | 38.9% | 42.9% |
| ≥2                 | 83.9% | 56.5% | 74.0% |
| **≥3** (deployed)  | 77.4% | **82.8%** | **93.5%** |
| ≥4                 | 61.3% | 95.0% | 98.7% |

≥1 is a real operating point — it catches 28 of 31 polyp patients. What it costs
is specificity: 44 of 77 clean patients get an alert. ≥3 trades 4 patients of
sensitivity for 39 fewer false alarms.

Both were fitted to patient-level labels. Per-image labels let us draw a real
**image-level ROC** and choose the point against a stated requirement — alerts
per procedure vs. sensitivity — instead of against a proxy.

---

## 2. Sampling: two separate decisions

Conflating these is what made earlier proportions look arbitrary.

### A. How many of each group ever get labelled — the pool

| group  | in pool | of available | why that amount |
| ------ | ------: | ------------ | --------------- |
| **fp** | **434** | **all**      | the group where the doctor may have missed something. Every one must be adjudicated: a "no" is a confirmed false alarm *and* a hard negative, a "yes" is a lesion the report never recorded |
| **fn** | **419** | **all**      | we cannot know whether the polyp was photographed at all. Only a per-image answer settles it, so all 6 studies in full (34, 47, 54, 58, 101, 125 images) |
| **tp** | **169** | **all**      | tests whether the model fired on the *right* image. Only 169 exist, so sampling buys nothing |
| **tn** | **154** | 154 of **4,302** | a bias control, not a finding. Showing all 4,302 would spend most of the doctor's time on images that are certainly nothing |

`fp` uses conf ≥ **0.30**, the floor of the eval sweep, so the pool spans the
whole decision range. Without images between 0.30 and 0.70 there is nothing to
move the threshold *with*.

TN is the only group that is sampled, so every TN image carries **weight 27.9**
(= 4302/154). A specificity computed without it describes the sample, not the
archive.

### B. What share of each session — the mix

**Each group's share of a session = its share of the pool: fp 37% / fn 36% /
tp 14% / tn 13%.** Computed from the live pool at session creation, so it cannot
drift.

This is not a preference. A group holding X% of the pool but given Y% of every
session finishes after X/Y of a full pass — the four only finish **together**
when X = Y. Measured over 500 images of simulated reading:

| group | reviewed | of pool |
| ----- | -------: | ------: |
| fp | 185 / 434 | 42.6% |
| fn | 180 / 419 | 43.0% |
| tp | 70 / 169  | 41.4% |
| tn | 65 / 154  | 42.2% |

Any other mix strands one group half-labelled.

### Why tp is 14% and not 0

The expected yes-rate across a session:

| mix | share of images that are a "yes" |
| --- | --- |
| with tp at 14% | **19%** |
| tp removed     | **10%** |

Without tp, one image in ten is a polyp and "no" becomes a reflex. tp roughly
doubles the yes-rate and doubles as the attention check.

### Why tn is 13%

It is the only source of images where the model is silent **and** the report is
clean. Its honest limit: 0 polyps in 154 bounds the unflagged miss rate at
≤2.4%, i.e. **up to ~100 missed images** across the archive. Tightening that
needs ~600 tn images — not worth the doctor's time, in my judgement.

---

## 3. How images are shown

### One at a time. No grid.

A grid is a different and easier task: it allows comparison between images,
which the model never gets; it yields no label for the images scrolled past; and
being handed a sheet and asked "which one" already says one of them has a polyp.

### Two phases, nothing in between

```
PHASE 1 — labelling, uninterrupted
   image only  →  "Is there a polyp?"  →  Yes / No / Not sure
                   Yes → optional box
   → a one-line explanation, then straight to the next image

PHASE 2 — one patient review, only once EVERY image of that patient is answered
   ├ found something      → whole patient + report: "do you stand by it?"
   ├ found nothing, and   → whole patient + report: "why?"
   │  report has a polyp
   └ found nothing, and   → nothing to ask
      report has none
```

The patient view never appears mid-stream. It interrupts the work and teaches
the reader what to expect next.

At the patient review the reader also sees, for the first time, **which images
the model had flagged** — dashed outline, against the solid outline of their own
marks. Every answer for that patient is already recorded, so it cannot influence
them, and it is still only the model's image-level flag, never its box.

### The model's box is never shown

Not before, not after. It is the anchor that would make the answer meaningless.
Whether the reader found the same thing is settled offline by comparing boxes —
which is why the box is worth asking for.

### The FN debrief

Saying no to all ~70 images of a missed study may be entirely correct. Five
structured answers, plus free text:

| answer            | what it means for the data                            |
| ----------------- | ----------------------------------------------------- |
| `not_captured`    | images are correctly negative; **not a model failure** |
| `now_visible`     | a genuine miss — and they can click the image          |
| `poor_quality`    | exclude from the recall denominator                    |
| `report_mismatch` | the label itself is suspect                            |
| `other`           | free text                                              |

`not_captured` is what stops the recall number being wrong in either direction.

---

## 4. What the reader gets back

**After each image** — which group it came from and what their answer is worth,
in one sentence. For example, after "no" on an fp image:

> The AI raised an alert on this image, but the report records no polyp. Your
> "no" confirms it was a false alarm — exactly the data that teaches the model
> to stop firing on images like it.

Twelve variants, one per group × answer, in Farsi and English.

**The cost, stated plainly.** Over a session this teaches the reader the base
rates, which can shift where they set their own threshold. It does **not** let
them predict the next image — nothing about the model's output or the report is
visible in the image itself, so knowing the last one's group gives no cue about
the next. Every annotation records `explained`, so the drift is measurable
rather than assumed absent. `CV_EXPLAIN=0` turns it off.

**At the end of a patient** — what the model had flagged versus what they marked.

**At the end of a session** — images labelled, marked as polyp, boxes drawn,
minutes, seconds per image, how many had never been reviewed by anyone before,
lifetime totals, and a bar showing how much of the pool now carries a label.

**Never a score.** "You were right" is the one thing that would teach a reader to
predict the model instead of reading the image. That comparison lives in the
export, after the reading is finished.

---

## 5. Keeping it statistically meaningful

**Blinding is enforced server-side.** An image's payload carries the image and
nothing else — no group, no confidence, no boxes, no report. Not hidden with
CSS, not sent-and-ignored: anything delivered to the browser is readable in
developer tools. Verified: no leaked fields across 500 simulated images.

**Randomisation.** Drawn per group, shuffled, then trimmed — so the cut falls
across all groups and position in the session says nothing about group.

**A designed overlap set.** 140 images (12%, stratified by group) that readers
are steered onto, 15% of every session. This gives a *common subset* for
Cohen's κ between readers instead of accidental collisions.

**Coverage and agreement, split explicitly.** The rest of each quota goes to
least-reviewed images first, and within that to patients the reader has already
started — which is what lets patients complete and the review screen fire.

**Attention checks, both directions.** tp catches a reader drifting to "always
no"; tn catches "always yes".

**Prevalence is recorded, not assumed away.** The mix is nothing like true
prevalence. The realised composition is stored per session and corrected for
later, together with the TN sampling weight.

**Time and position logged per image**, so fatigue and rushing are visible.

**Append-only.** Revisions write a new row via `revision_of`. The blind answer is
never overwritten by the patient-level one — only the blind answer is an
unprompted label.

---

## 6. What comes out

| outcome                                    | used for                                 |
| ------------------------------------------ | ---------------------------------------- |
| blind **no** on an `fp` image              | confirmed false positive → hard negative  |
| blind **yes** + confirmed at patient level | **lesion the report missed**              |
| blind **yes** on an `fn` image, with a box | a true miss → positive training example   |
| `not_captured` debrief                     | study excluded from the recall denominator |
| blind **no** on a `tp` image               | model fired on the wrong image            |
| every image, with weights                  | **image-level ROC** → an honest threshold |

Export is one JSONL row per annotation with the reader's boxes and the model's,
the group, sampling weight, overlap flag, timing, position, and whether the
explanation was shown.

---

## 7. Security

Admin-issued accounts only (no registration), Argon2id, forced password change
before any image is reachable, HttpOnly + Secure + SameSite=Strict cookies, CSRF
tokens, lockout with backoff, 30-minute idle timeout, full audit log, nightly
snapshot. Images are served only through an authenticated endpoint tied to the
requesting reader's own worklist — never as static files.

1. The stills carry a **burned-in patient banner** — `ID: / Name: / D.O.B.`
   (empty in all 427 studies, verified) and the **procedure date/time**
   (populated). It is in the raster, so stripping EXIF does nothing. The left
   30% of every image is discarded; costs 13.5% of detections but cannot fail
   silently the way a text detector can. See `scripts/deid.py`.
2. `crosswalk.csv`, mapping `C-0137` back to real reception IDs, **never leaves
   the build machine**. The server holds pseudonyms only.

---

## 8. Known limits

- **Six FN studies is thin.** Recall estimates from 6 studies carry very wide
  intervals. The panel will say much about false positives and little about
  misses until there are more report-positive studies the model stayed quiet on.
- **The report is a reference standard, not ground truth.** Pathology would be
  better for "is this neoplastic"; the report cannot settle it.
- **41 fp detections were dropped** — their box sat in the discarded banner
  column and cannot be reviewed.
- **Enrichment cannot be undone**, only corrected for. Reader thresholds on this
  worklist are not the thresholds they would have in clinic.
- **The per-image explanation is a deliberate trade** of some blinding for
  engagement. Logged, switchable, and worth re-examining once real reading data
  exists.
