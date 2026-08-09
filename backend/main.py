"""
FastAPI backend.
Run:  uvicorn backend.main:app --reload --port 8000
"""

import logging
import logging.handlers
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.routes import infer, feedback

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

app = FastAPI(title="Polyp Detection API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(infer.router, prefix="/api")
app.include_router(feedback.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
