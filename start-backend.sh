#!/bin/bash
cd /home/arman/noormind/polyp-detection
exec venv/bin/python3 venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 19000
