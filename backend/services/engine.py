"""Chooses which inference engine serves a request.

    modal        the serverless T4 reached over Modal's RPC — the default
    cpu:<model>  this machine's own CPU, in-process, through ONNX Runtime

The CPU engine carries its model in the name ("cpu:yolo11n") so that a single
string still selects an engine everywhere one is passed — websocket query param,
session/start, and the UI — with no second parameter to thread through.

Modules are imported lazily so a deployment that will never use one does not need
its dependencies installed: call2fly has no torch, and a box with no onnx models
should simply not offer the CPU engine rather than fail when it is picked.
"""

import logging
import os

log = logging.getLogger("engine")

DEFAULT = "modal"


def resolve(name: str | None):
    """Normalise an engine name and hand back something exposing warmup /
    infer_frame / infer_video. Raises ValueError on an unknown name."""
    chosen = (name or DEFAULT).strip().lower()

    if chosen == "modal":
        from backend.services import modal_client
        return "modal", modal_client

    if chosen == "cpu" or chosen.startswith("cpu:"):
        from backend.services import local_cpu
        variant = chosen.split(":", 1)[1] if ":" in chosen else local_cpu.DEFAULT_MODEL
        return f"cpu:{variant}", local_cpu.bind(variant)

    raise ValueError(f"unknown inference engine {chosen!r} (expected 'modal' or 'cpu:<model>')")


def is_cpu(name: str | None) -> bool:
    return bool(name) and name.strip().lower().startswith("cpu")


def availability() -> dict:
    """What this process can actually serve right now.

    The UI reads this so it never offers a choice that is going to fail — a box
    with no onnx models shouldn't advertise the CPU engine.
    """
    cpu_ok, cpu_models, cpu_device = False, [], None
    try:
        from backend.services import local_cpu
        cpu_ok = local_cpu.available()
        cpu_models = local_cpu.available_models()
        cpu_device = local_cpu.device_name()
    except Exception as e:  # onnxruntime absent, or models not deployed
        log.debug("cpu engine unavailable: %s", e)

    return {
        "default": os.getenv("INFERENCE_BACKEND", DEFAULT),
        "available": {"modal": True, "cpu": cpu_ok},
        "cpu": cpu_device,
        # One entry per selectable CPU model, each flagged with whether it is
        # actually polyp-trained. The nano models are stock COCO weights carried
        # as speed probes and will find nothing on colonoscopy frames.
        "cpu_models": cpu_models,
    }
