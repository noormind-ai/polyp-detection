# Decisions

One line per topic, Y-statement format: "In the context of [use case],
facing [concern], we decided [option] to achieve [quality], accepting
[downside]." Full reasoning and benchmark data live in documents/adr/.

## Video-labeling propagation engine

In the context of backward box propagation for the video-labeling platform on noormind-iran, facing a choice between optical-flow tracking and SAM2 video segmentation now that the box has a GPU (RTX A2000, added 2026-09-27), we decided to keep optical flow (Median Flow / LK) as the default and only propagation engine, to achieve fast (~11ms/frame) dependency-light propagation that is never less accurate than SAM2 on this footage, accepting that SAM2's better persistence through occluded/hard stretches stays available only as an unused-by-default manual fallback (documents/adr/0001-propagation-engine-flow-vs-sam2.md).
