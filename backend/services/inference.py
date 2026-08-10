"""Chooses which inference backend serves a request.

Two exist, and both are real deployments rather than a migration in progress:

  modal — the serverless A100 reached over Modal's RPC (call2fly.ai)
  local — this machine's own NVIDIA GPU, in-process (IranServer)

INFERENCE_BACKEND sets the default for a deployment. Individual calls may override
it, which is what lets the UI offer the choice: running both from the same box,
same client and same network is the only way a comparison between them means
anything.

Backend modules are imported lazily so that a deployment which will never use one
of them doesn't need its dependencies installed — call2fly has no torch, and the
GPU box need not have Modal credentials.
"""

import logging
import os

log = logging.getLogger("inference")

BACKENDS = ("local", "modal")


def default_backend() -> str:
    return (os.getenv("INFERENCE_BACKEND") or "modal").strip().lower()


def _module(name: str):
    if name == "local":
        from backend.services import local_gpu
        return local_gpu
    if name == "modal":
        from backend.services import modal_client
        return modal_client
    raise ValueError(f"unknown inference backend {name!r} (expected one of {', '.join(BACKENDS)})")


def resolve(name: str | None) -> tuple[str, object]:
    """Normalise a requested backend name and hand back the module serving it."""
    chosen = (name or default_backend()).strip().lower()
    if chosen not in BACKENDS:
        raise ValueError(f"unknown inference backend {chosen!r} (expected one of {', '.join(BACKENDS)})")
    return chosen, _module(chosen)


def availability() -> dict:
    """What this process can actually serve right now.

    The UI reads this so it never offers a choice that is going to fail — a box
    with no GPU shouldn't advertise "local", and one with no Modal credentials
    shouldn't advertise "modal".
    """
    local_ok = False
    device = None
    try:
        from backend.services import local_gpu
        local_ok = local_gpu.available()
        device = local_gpu.device_name()
    except Exception as e:  # torch/ultralytics absent is the normal case on call2fly
        log.debug("local backend unavailable: %s", e)

    modal_ok = bool(os.getenv("MODAL_TOKEN_ID") and os.getenv("MODAL_TOKEN_SECRET"))

    return {
        "default": default_backend(),
        "available": {"local": local_ok, "modal": modal_ok},
        "gpu": device,
    }


async def warmup(backend: str | None = None) -> tuple[str, str]:
    name, mod = resolve(backend)
    return name, await mod.warmup()


async def infer_frame(frame_bytes: bytes, backend: str | None = None) -> tuple[list[dict], dict]:
    name, mod = resolve(backend)
    boxes, timing = await mod.infer_frame(frame_bytes)
    timing["backend"] = name
    return boxes, timing


async def infer_video(video_bytes: bytes, backend: str | None = None) -> dict:
    _, mod = resolve(backend)
    return await mod.infer_video(video_bytes)
