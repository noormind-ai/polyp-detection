"""
FastAPI backend.
Run:  uvicorn backend.main:app --reload --port 8000
"""

import logging
import logging.handlers
import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend import auth
from backend.routes import auth as auth_routes, infer, feedback, recordings

# File logger — writes to logs/backend.log, rotates at 5 MB, keeps 3 files
Path("logs").mkdir(exist_ok=True)
handler = logging.handlers.RotatingFileHandler(
    "logs/backend.log", maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
)
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s — %(message)s"))
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)

# Suppress Modal's internal gRPC / hpack debug noise
for noisy in ("hpack", "grpc", "modal", "h2", "httpx", "httpcore"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

if auth.SECRET_IS_EPHEMERAL:
    print("WARNING: POLYP_SECRET not set — session cookies are signed with a "
          "per-process key, so every restart signs all users out.")
if auth.using_default_credentials():
    print(f"WARNING: default account '{auth.DEFAULT_USER}' still has its default "
          "password. Set POLYP_USERS before exposing this publicly.")

app = FastAPI(title="Polyp Detection API")

# In production the frontend is same-origin (noormind.me/polyp -> noormind.me/api),
# so CORS never applies and the session cookie is sent automatically. Only local
# dev is cross-origin, and credentialed requests cannot use a "*" origin — so
# listing origins explicitly is what turns credentials on.
CORS_ORIGINS = [o.strip() for o in os.environ.get("POLYP_CORS_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or ["*"],
    allow_credentials=bool(CORS_ORIGINS),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_routes.router, prefix="/api")
app.include_router(infer.router, prefix="/api")
app.include_router(feedback.router, prefix="/api")
app.include_router(recordings.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
