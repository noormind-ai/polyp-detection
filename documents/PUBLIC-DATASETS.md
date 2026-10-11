# Public colonoscopy / polyp datasets — what exists, what we hold

Last updated **2026-09-15**.

One page for every public dataset we've looked at: size, licence, where it lives,
how to get it, and **whether we actually have it**. Keep it current — the point is
to stop re-deriving "how big is it and can we even download it" every few months.

> **No data in this repo.** Only this file is tracked. Datasets live on disk
> (laptop `F:\codes\noormind\`, the Modal Volume `polyp-models`, or the Iran box)
> and are gitignored everywhere. Patient data never leaves the Iran box at all.

## Status legend

| | meaning |
|---|---|
| ✅ **held** | downloaded, on disk now, path given |
| 🟡 **derived** | we hold a processed subset, not the original archive |
| ⬜ **available** | freely downloadable, we just haven't pulled it |
| 🔒 **gated** | needs an account, application, or email request |
| ❌ **blocked** | cannot be obtained on our current infrastructure |

Sizes marked **(measured)** were read off the host on 2026-09-15 via the
Figshare/Zenodo API or a range request. Sizes marked **(paper)** are quoted from a
publication and not independently checked. Where neither appears, the size is
**not known** — the host returns no `Content-Length` and nobody has downloaded it.
Don't fill these in by guessing.

---

## 1. In the training corpus today

Six sources, pooled and deduplicated into `F:\codes\noormind\corpus\` (**646 MB**
on disk, 4,364 images, 3,900 boxes, 745 negative frames). Splits:
`train 3,330 · val 370 · test 196 · test_colondb 380 · val_ood 88`.

Everything here is 🟡 **derived** — we hold the pooled YOLO-format corpus, not the
original archives. Rebuild with `polyp-detection/training/modal_train.py`, which
pulls from HuggingFace, not from the original hosts.

| Dataset | Contribution to corpus | Source | Role |
|---|---|---|---|
| **Kvasir-SEG** | 1,061 boxes → 998 train | HF `kowndinya23/Kvasir-SEG` | Main training source. Simula's own copy is at `datasets.simula.no/downloads/kvasir-seg.zip`. |
| **PolypGen 2.0** | 1,508 boxes → 1,377 train, 88 `val_ood`, 126 negatives | HF `halyusuf/PolypGen2.0` | 6-centre. Centre C6 is held out as the out-of-distribution val set. |
| **CVC-ClinicDB** | 646 boxes → 612 train | HF `kinghoon/polyp-dataset` | 612 frames, 29 sequences. Standard training half of the PraNet protocol. |
| **CVC-ColonDB** | 380 boxes → 380 `test_colondb` | HF `kinghoon/polyp-dataset` | **Held out.** 380 frames from only ~13–15 sequences / 13 patients — thin as training data, genuine as a second-centre read. |
| **ETIS-LaribPolypDB** | 208 boxes → 196 `test` | HF `kinghoon/polyp-dataset` | **Held out** as the primary test set. Emitted first during dedup so overlaps get dropped from train, never from test. |
| **RXO** | 97 boxes → 94 train | HF `kinghoon/polyp-dataset` | Small supplementary set. |

Note `kinghoon/polyp-dataset` also ships a `kvasir-seg/` folder — **deliberately
skipped** (1,000 images but only 428 masks); Kvasir comes from `kowndinya23`'s
complete copy instead.

Plus 1,036 negative frames pooled from the above ("combo" in `corpus/manifest.json`).

---

## 2. Evaluated and rejected

### InfoColon ❌ blocked · ~92.6 GB (paper)

Informative-frame classification, 7 classes: `informative`, `wall`, `bubble`,
`blurry`, `bad_light`, `tool`, `obstacles`.

- Paper: *Scientific Data* 2026, [doi 10.1038/s41597-026-07060-2](https://doi.org/10.1038/s41597-026-07060-2) · PMC13184289 (open access)
- Data: Synapse [`syn55251782`](https://www.synapse.org/InfoColon) · Code: `github.com/Choi-Tae-min/InfoColon`
- **Licence: CC BY-NC-ND 4.0** — NC blocks commercial deployment, ND arguably blocks even an ONNX export.

| Part | Content | Size (paper) | Synapse ID |
|---|---|---|---|
| SNUH videos | 151 videos, 110,587 labelled frames | 81.9 GB | `syn69939822` |
| CNUH videos | 13 videos, 9,211 labelled frames | 10.7 GB | `syn68697859` |
| Calibration | 2 checkerboard videos + 2 camera-param xlsx | negligible | `syn68697858` |
| Open-dataset labels | **CSV labels only** | negligible | `syn68697868` |

**164 videos total**, not the 171 sometimes quoted — 151 + 13, confirmed by
enumerating the Synapse tree (701 files / 170 folders) on 2026-09-15. Per-video
folder is `{VID}.mp4` + `{VID}_Label.csv` + `{VID}_Summary_report.png`.
SNUH 488×416 or 528×416 @ ~23 fps; CNUH 654×480 or 720×480 @ ~60 fps; MP4V codec.
**Labels are per-second, not per-frame.**

**Why blocked — two independent problems, both must be solved:**

1. **Synapse geo-blocks the region.** From the Iran box, both `www.synapse.org`
   and `repo-prod.prod.sagebase.org` return
   `403 {"errorCode": "GEO_RESTRICTION"}`, citing NIH notice NOT-OD-25-083.
   No proxy on that box. Working routes: the laptop, and `call2fly.ai`
   (Hetzner Helsinki). So any download must land elsewhere and rsync in.
2. **Anonymous download is refused.** The folder tree reads fine unauthenticated,
   but file handles come back empty and `/entity/{id}/file` returns
   *"Anonymous users have only READ access permission."* Needs a Synapse
   Personal Access Token (free account, Account Settings → Personal Access Tokens,
   scopes View + Download; put it in `~/.synapseConfig`).

**The genuinely useful part is the small part.** The public-dataset rows in the
paper's Table 1 are **label CSVs only** — Synapse does not host those images. So
InfoColon gives you its 7-class labels over **Hyper-Kvasir and Nerthus**, both
permissively licensed. That is a route to a quality-gate training set that avoids
InfoColon's own NC-ND terms, and it is well under 1 GB.

Frames InfoColon drew from each public source (paper Table 1 — these are
*InfoColon's subset*, not the full datasets):

| Source | Frames | Size (paper) |
|---|---|---|
| LDPolyps | 39,060 | 2.75 GB |
| Hyper-Kvasir (lower-GI labelled) | 5,219 | 851 MB |
| Nerthus | 5,525 | 307 MB |
| Endomapper (simulated sequences) | 1,919 | 1.98 GB |
| SeamXSim (synthetic clips) | 204 (13 clips) | 7.13 MB |

**Their model was tested and rejected** — full write-up in the notes repo at
`documents/infocolon-benchmark.md` (not in this repo).
Published 96.1% internal / 91.2% external did not transfer: on our
footage the gate muted **58% of labelled polyp frames**, **63% of confirmed
polyps**, and **81% of the lesions the AI had already missed** — and no threshold
fixed it. Speed was fine (~32 ms, amortisable at 2–5 Hz); quality was not.

✅ **Weights we do hold**: `F:\codes\noormind\weights\infocolon\` — 745 MB,
3 × ~248 MB checkpoints (2-class, 6-class, 7-class) from the authors' Google Drive
folder, plus ONNX exports in `bench-infocolon/models/`. Preprocessing is
`Resize((224,224)) → ToTensor()` with **no Normalize** — get this wrong and every
number is meaningless.

---

## 3. Available, not downloaded

### REAL-Colon ⬜ · 945.7 GB (measured)

60 full colonoscopies, ~2.7 M frames, from 6 centres across 4 countries — the
largest real-colonoscopy video set that is openly downloadable.

- Figshare article `22202866` — **123 files, 945.7 GB total** (measured via the
  Figshare API, 2026-09-15). Per-video `_frames.tar.gz` run **~7–11 GB each**,
  with a tiny `_annotations.tar.gz` alongside.
- Figshare is reachable from the Iran box (HTTP 202).
- **Subset-only, always.** It cannot fit anywhere we have: Iran box 17 GB free,
  laptop `F:` 67 GB free. The per-video packaging makes subsetting easy.
- Relevant to video labelling: its reverse-annotation protocol is the one worth
  copying for a video labelling tool.

### FoldIt ⬜ · 0.51 GB (measured) · CC BY 4.0

Zenodo record [`5519974`](https://zenodo.org/records/5519974) —
`foldIt_public_data.zip` 248 MB + `foldit_model_public.zip` 264 MB.
Colon-fold annotations; relevant to blind-spot / withdrawal-quality work.
Permissive licence, small, reachable from the Iran box. Cheapest useful pull on
this page.

> Partially engaged already: `~/foldit-myclip-frames/` exists on the Iran box and
> `papers/foldit.pdf` is in the notes repo — but the Zenodo archive itself has not
> been downloaded.

### Hyper-Kvasir ⬜ · size not measured

Simula. Multi-class GI endoscopy: labelled images, segmented images, labelled
videos, and a large unlabelled image set, downloadable as separate zips from
`datasets.simula.no/downloads/hyper-kvasir/`. Permissive licence.

Worth having for the **tier-2 quality gate** — our own benchmark recommended
training on Hyper-Kvasir + Nerthus + our own recordings precisely because
InfoColon's licence and domain shift rule it out.

### Nerthus ⬜ · size not measured (InfoColon used 5,525 frames / 307 MB)

Simula. Bowel-prep quality (BBPS) scored video frames. Small. Pairs with
Hyper-Kvasir for gate training, and InfoColon publishes 7-class labels over it.

### Kvasir-SEG / Kvasir v2 ⬜ · size not measured

Simula originals of what we already use via HuggingFace. No need to pull unless
we want the authoritative archive rather than the HF mirror.

> ⚠️ **Simula TLS gotcha.** `datasets.simula.no` serves an **incomplete
> certificate chain** (missing intermediate). From the Iran box curl fails with
> `unable to get local issuer certificate`. This is **not** a geo-block — the host
> returns 200 from the laptop. Work around it with a proper CA bundle or
> `--cacert`; don't conclude the site is censored.

### LDPolypVideo ⬜ · size not measured (InfoColon used 39,060 frames / 2.75 GB)

Colonoscopy video with polyp annotations. Distributed via the authors' GitHub
pointing at cloud-drive links. Useful for sequence models and for the video
labelling work.

### Endomapper ⬜ · size not measured (InfoColon used 1,919 frames / 1.98 GB)

Complete calibrated endoscopy procedures (*Scientific Data* 2023). Large;
calibration data makes it relevant to 3D/VSLAM work rather than detection.

---

## 4. Not publicly downloadable

### ENDOTEST 🔒 — request only

CADe benchmark from Interventional and Experimental Endoscopy (InExEn),
Universitätsklinikum Würzburg. Paper: *Scand J Gastroenterol* 2022,
[doi 10.1080/00365521.2022.2085059](https://doi.org/10.1080/00365521.2022.2085059),
PMID 35701020 — **paywalled**.

| Part | Content |
|---|---|
| Validation set | 48 video snippets, 22,856 annotated frames, **53.2% polyp** |
| Performance set | 10 full screening colonoscopies, 230,898 annotated frames, **15.8% polyp** |

Searched 2026-09-15: **not on Zenodo** (0 hits for "endotest"), not on Figshare,
and the paper carries no data-availability URL. Access means emailing UKW.
The **ENDOMIND model** is free for research; the **dataset** is not.

Why it's worth chasing anyway: full-length colonoscopies with *every* frame
annotated are exactly what's needed to measure the downstream recall cost of a
quality gate — and its 15.8% polyp-frame rate is a realistic prevalence, unlike
the polyp-enriched still-image sets.

### PICCOLO 🔒 — request only

Zenodo [`4279017`](https://zenodo.org/records/4279017) holds **only the paper and
a readme** (measured 2026-09-15) — no images. Licence recorded as `other-nc`.
White-light + narrow-band imaging frames; actual data is requested from the
Basque biobank.

---

## 5. Host reachability from the Iran box

Checked 2026-09-15 from `noormind-iran` (31.214.168.29). Re-test before assuming.

| Host | Result | Note |
|---|---|---|
| HuggingFace | ✅ 200 | how the corpus is rebuilt |
| Zenodo | ✅ 200 | FoldIt, PICCOLO |
| Figshare | ✅ 202 | REAL-Colon |
| GitHub | ✅ 200 | |
| `datasets.simula.no` | ⚠️ TLS | incomplete cert chain, not a block — see above |
| Synapse | ❌ 403 | `GEO_RESTRICTION`, region-wide |

Disk, same date: Iran box **17 GB free of 39 GB** (shared with the live app —
filling it takes `ir.noormind.me` down); laptop `F:` **67 GB free**;
`call2fly.ai` **23 GB free of 150 GB** (85% full, shared with OrganAI).

---

## 6. Models

| Model | Status | Notes |
|---|---|---|
| **YOLOv5m** (`goktug14/yolov5_kvasir_polyp`) | ✅ deployed | Kvasir-only. Still the production detector. |
| **YOLO11m-multi** | ✅ held | `weights/yolo11m_multi.pt`. Beats YOLOv5m on public benchmarks but **ties on our 108 report-linked studies**, so it was not promoted. |
| **YOLO11n / YOLO11n-320** | ✅ held | Smaller variants, evaluated in `data/eval-yolo11n*`. |
| **RT-DETR-R18** | ✅ held | Clearly worse on our studies (AUC 0.739). |
| **InfoColon ViT-S/16** | ✅ held, rejected | `weights/infocolon/`. See §2. |
| **MobileNetV3-small frame-quality** | ✅ held | `weights/frame_quality_mnv3s.pt` — the in-house tier-2 gate direction. |

Study-level results for the detectors are in `data/DATA-REPORT.md` in the notes
repo (108 studies, 31 with a polyp).

---

## 7. Open items

- **InfoColon labels-only pull** (<1 GB) — needs a Synapse PAT and a non-blocked
  route. Highest value-per-byte item on this page.
- **FoldIt** (0.51 GB, CC BY 4.0) — no blockers at all, just hasn't been done.
- **ENDOTEST** — email UKW InExEn if full-length annotated colonoscopies become
  the bottleneck.
- **OSABPS** — deferred 2026-08-29, not downloaded. Single-frame stool score only;
  it does *not* measure withdrawal speed or technique. Rationale in
  `documents/colonoscopy-quality-metrics.md`.
- Fill in the **"size not measured"** rows when anything is actually downloaded —
  by measuring, not by quoting a paper.
