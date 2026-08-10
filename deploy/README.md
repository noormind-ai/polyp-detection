# Deploying to a GPU box

One command on a fresh Ubuntu 24.04 machine that already has an NVIDIA driver:

```bash
sudo bash deploy/bootstrap.sh
```

Roughly 10–15 minutes, most of it downloading PyTorch. It is idempotent — re-run
it after a config change or a failed attempt.

Override anything via environment:

```bash
PUBLIC_HOST=polyp.example.com BRANCH=iranserver-local-gpu sudo -E bash deploy/bootstrap.sh
```

| Variable | Default |
|---|---|
| `REPO` | `git@github.com:noormind-ai/polyp-detection.git` |
| `BRANCH` | `main` |
| `APP_DIR` | `/opt/polyp-detection` |
| `VENV_DIR` | `/opt/polyp-venv` |
| `PUBLIC_HOST` | detected public IP |
| `BACKEND_PORT` / `FRONTEND_PORT` | `19000` / `19001` |
| `SSH_PORT` | read from `sshd_config` |

## What it does not do

- **Install the GPU driver.** That is the provider's job, and clobbering a
  working driver is a good way to lose a box. The script refuses to run if
  `nvidia-smi` is missing.
- **Get a trusted certificate.** It generates a self-signed one so the app works
  immediately. Point a DNS name at the host and run `certbot --nginx -d <name>`
  for a real one — then rebuild the frontend, since `NEXT_PUBLIC_API_URL` is
  baked in at build time.
- **Carry over feedback data.** `backend/data/feedback/` is per-machine clinical
  capture data and is gitignored. Copy it deliberately if you mean to.

## What is where

| | |
|---|---|
| Code | this repo |
| Model weights | HuggingFace `goktug14/yolov5_kvasir_polyp`, fetched at bootstrap |
| Demo clips | tracked in the repo, `frontend/public/demos/` |
| systemd units | `deploy/*.service`, templated into `/etc/systemd/system/` |
| nginx config | `deploy/nginx-polyp.conf` → `/etc/nginx/sites-available/polyp.conf` |
| Secrets | `backend/.env`, gitignored — only `INFERENCE_BACKEND=local` is needed for a GPU box |

Nothing needed to rebuild this deployment lives only on a server. That is the
point: losing the machine costs a bootstrap run, not a reconstruction.

## Choosing where inference runs

`INFERENCE_BACKEND` in `backend/.env` picks the default: `local` (this machine's
GPU, in-process) or `modal` (serverless A100). `GET /api/backends` reports what a
deployment can actually serve, and the UI shows both, disabling whichever is
unavailable. Adding `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` to `backend/.env`
lights up the Modal option so the two can be compared from the same page.

## Gotchas this script already handles

Learned while bringing up the IranServer box; all of them cost real time.

- **No IPv6 route, but DNS returns AAAA records** — every connection wasted a
  `Network is unreachable` attempt first. Fixed by an IPv4 precedence line in
  `/etc/gai.conf`, which also unstuck a `git clone` that was stalling at 124 KB.
- **`files.pythonhosted.org` unroutable while `pypi.org` answers** — installs die
  mid-download. The script tests it and falls back to an Iranian PyPI mirror.
- **`nvidia-container-toolkit` is not installable** from this network
  (`nvidia.github.io` resets the connection), which is why this is a bare-metal
  venv deployment rather than Docker.
- **Ubuntu 24.04 is PEP 668** — system pip refuses to install; a venv is required.
- **Ubuntu's nodejs 18.19 is new enough** for Next 14 (needs ≥18.17), so there is
  no dependency on NodeSource being reachable.
- **`ufw` must allow the SSH port before being enabled**, and this box uses a
  non-standard one. The script reads it from `sshd_config` rather than assuming 22.
- **Plain HTTP gets its JS rewritten in transit** — see the comment in the nginx
  config. Deploying without TLS produces a blank page that looks like an app bug.
