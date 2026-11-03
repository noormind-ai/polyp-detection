# Decisions

One line per topic, Y-statement format: "In the context of [use case],
facing [concern], we decided [option] to achieve [quality], accepting
[downside]." Full reasoning and benchmark data live in documents/adr/.

## Video-labeling propagation engine

In the context of backward box propagation for the video-labeling platform on noormind-iran, facing a choice between optical-flow tracking and SAM2 video segmentation now that the box has a GPU (RTX A2000, added 2026-09-27), we decided to keep optical flow (Median Flow / LK) as the default and only propagation engine, to achieve fast (~11ms/frame) dependency-light propagation that is never less accurate than SAM2 on this footage, accepting that SAM2's better persistence through occluded/hard stretches stays available only as an unused-by-default manual fallback (documents/adr/0001-propagation-engine-flow-vs-sam2.md).

## Tier 3 alert now fires on capture, not its own timer

In the context of the three-tier live-inference response (box, capture,
alert) on noormind-iran, facing an alert bar that was harder to clear than
the already-infrequent capture bar and so rarely fired even when a capture
was filed, we decided to make tier 3 fire whenever tier 2 files a capture
(dropping the independent ALERT_MIN_MS/ALERT_MIN_CONF gate) to achieve a
beep for every captured image, accepting that if a future model raises
capture volume back up, tier 3 gets noisy again automatically since it now
equals tier 2 (documents/adr/0002-capture-also-alerts.md).

## Detection gates off by default

In the context of live polyp detection on noormind-iran, facing five stacked
mechanisms that could withhold a detection -- including a client-side 2-of-3
persistence gate whose cost was unmeasurable because tier 2 filing is fed
post-gate boxes, and a ByteTrack instance silently enforcing a 0.40 confidence
floor on new lesions plus its own non-switchable 2-frame rule -- we decided to
default the temporal and frame-quality gates to off and stop running ByteTrack
on the live stream, to achieve a path where the model's output reaches the
screen and the lesion the doctor missed is not filtered out by an unvalidated
filter, accepting more per-frame false positives and more alerts, and accepting
that the recall gained is as unmeasured as the recall previously lost until the
saved clinic recordings are replayed; and, so that no beep is left without an
image behind it, we decided to file two captures per appearance -- the first
detected frame immediately with no bar, plus the clearest frame of the window as
before -- labelled `first`/`best` in a new manifest column
(documents/adr/0005-detection-gates-off-by-default.md).

## Agent code map generator

In the context of giving an AI assistant a fast, accurate way to find routes
and components in this repo instead of re-searching it every session, facing
a choice between a hand-maintained map (drifts the first time it's not
updated), a tree-sitter generator (the 2026 community standard, but needing
a new dependency to handle multi-line signatures this codebase's style never
actually produces), and a live tree-sitter MCP server (no file, so invisible
to anyone browsing the repo directly), we decided to generate
`documents/AGENT_MAP.md`'s route/export listing with a small dependency-free
regex script (`documents/generate_agent_map.py`) to achieve an
always-regenerable, git-visible index with zero new dependencies, accepting
that a future style change (e.g. multi-line decorators) could make it
silently miss entries until the map is noticed to look thin
(documents/adr/0008-agent-map-regex-generator.md).
