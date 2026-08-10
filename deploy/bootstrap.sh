#!/usr/bin/env bash
#
# Provision a fresh Ubuntu 24.04 box with an NVIDIA GPU into a working
# Polyp Detection deployment: backend + frontend + local GPU inference behind
# nginx/TLS, under systemd, with a firewall.
#
#   curl -fsSL https://raw.githubusercontent.com/noormind-ai/polyp-detection/main/deploy/bootstrap.sh | bash
#
# or, having cloned already:
#
#   sudo bash deploy/bootstrap.sh
#
# Assumes: Ubuntu 24.04, root, NVIDIA driver already installed (nvidia-smi works).
# It does NOT install the GPU driver — that is the provider's job and doing it
# here would risk breaking a working one.
#
# Idempotent: safe to re-run. Every step checks before it acts.
#
set -euo pipefail

REPO="${REPO:-git@github.com:noormind-ai/polyp-detection.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/polyp-detection}"
VENV_DIR="${VENV_DIR:-/opt/polyp-venv}"
BACKEND_PORT="${BACKEND_PORT:-19000}"
FRONTEND_PORT="${FRONTEND_PORT:-19001}"
SSH_PORT="${SSH_PORT:-$(grep -oP '^\s*Port\s+\K\d+' /etc/ssh/sshd_config 2>/dev/null | head -1 || echo 22)}"
# Public address browsers will use. Must match the cert, and is baked into the
# frontend bundle at build time.
PUBLIC_HOST="${PUBLIC_HOST:-$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# --- 0. sanity ---------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
command -v nvidia-smi >/dev/null || {
  echo "nvidia-smi not found — install the GPU driver first, then re-run." >&2
  exit 1
}
say "GPU detected"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader

# --- 1. network quirks (learned the hard way on Iranian networks) -------------
# DNS returns AAAA records but many of these boxes have no IPv6 route, so every
# connection burns a "Network is unreachable" attempt first. Prefer IPv4.
if ! grep -q '^precedence ::ffff:0:0/96' /etc/gai.conf 2>/dev/null; then
  say "Preferring IPv4 in /etc/gai.conf"
  echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf
fi

# PyPI's Fastly CDN (files.pythonhosted.org) is intermittently unroutable from
# Iran even when pypi.org itself answers, which breaks installs mid-download.
# Point pip at a mirror that is reachable, if the direct route is not.
if ! curl -4 -fsS -o /dev/null --max-time 15 https://files.pythonhosted.org/ 2>/dev/null; then
  say "files.pythonhosted.org unreachable — configuring PyPI mirror"
  cat > /etc/pip.conf <<'CFG'
[global]
index-url = https://mirror-pypi.runflare.com/simple/
trusted-host = mirror-pypi.runflare.com
timeout = 60
retries = 10
CFG
fi

# --- 2. system packages ------------------------------------------------------
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# nodejs 18.19 from the Ubuntu archive is >= the 18.17 that Next 14 requires,
# which avoids depending on NodeSource being reachable.
apt-get install -y -qq git python3-venv python3-dev build-essential \
                       nodejs npm nginx openssl curl ufw

# --- 3. code -----------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing checkout"
  git -C "$APP_DIR" fetch -q --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard FETCH_HEAD
else
  say "Cloning $REPO ($BRANCH)"
  # Shallow: the demo clips make a full history clone slow over a throttled link.
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
git -C "$APP_DIR" log --oneline -1

# --- 4. python + model deps --------------------------------------------------
if [ ! -x "$VENV_DIR/bin/python" ]; then
  say "Creating venv at $VENV_DIR"
  # Deliberately outside the checkout: a git clean or re-clone must never be able
  # to destroy a multi-GB install.
  python3 -m venv "$VENV_DIR"
fi
say "Installing Python dependencies (torch is ~800MB, be patient)"
"$VENV_DIR/bin/pip" install -q --upgrade pip
# Pinned pair: torch 2.5.1 bundles CUDA 12.4 and has well-tested sm_75 kernels,
# which covers Turing cards (RTX 2080 Ti) as well as everything newer.
"$VENV_DIR/bin/pip" install -q torch==2.5.1 torchvision==0.20.1
"$VENV_DIR/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
"$VENV_DIR/bin/pip" install -q -r "$APP_DIR/backend/requirements-gpu.txt"

say "Verifying the GPU is actually usable from torch"
"$VENV_DIR/bin/python" - <<'PY'
import sys, torch
if not torch.cuda.is_available():
    sys.exit("torch cannot see the GPU — check the driver before continuing")
print("torch", torch.__version__, "| device", torch.cuda.get_device_name(0),
      "| capability", torch.cuda.get_device_capability(0))
PY

# Pull the weights now rather than on the first user's click (~50MB from HF).
say "Pre-fetching model weights"
YOLO_CONFIG_DIR=/root/.config/Ultralytics "$VENV_DIR/bin/python" - <<'PY'
from huggingface_hub import hf_hub_download
print(hf_hub_download(repo_id="goktug14/yolov5_kvasir_polyp", filename="weights/best.pt"))
PY

# --- 5. config ---------------------------------------------------------------
say "Writing config for host $PUBLIC_HOST"
[ -f "$APP_DIR/backend/.env" ] || cat > "$APP_DIR/backend/.env" <<ENV
INFERENCE_BACKEND=local
ENV
# NEXT_PUBLIC_* are inlined at build time — changing these later needs a rebuild,
# not a restart. Same origin as the page, so nginx terminates TLS for both.
cat > "$APP_DIR/frontend/.env.local" <<ENV
NEXT_PUBLIC_API_URL=https://$PUBLIC_HOST
NEXT_PUBLIC_BASE_PATH=
ENV

# --- 6. frontend build -------------------------------------------------------
say "Building the frontend"
cd "$APP_DIR/frontend"
npm ci --no-audit --no-fund
npm run build

# --- 7. TLS ------------------------------------------------------------------
# Plaintext HTTP is intercepted and rewritten on some networks (Iranian filtering
# returns a 302 to 10.10.34.35 for JS bundles), which silently breaks the app.
# TLS is required for correctness here, not just privacy.
mkdir -p /etc/nginx/ssl
if [ ! -f /etc/nginx/ssl/polyp.crt ]; then
  say "Generating a self-signed certificate for $PUBLIC_HOST"
  SAN="DNS:$PUBLIC_HOST"
  [[ "$PUBLIC_HOST" =~ ^[0-9.]+$ ]] && SAN="IP:$PUBLIC_HOST"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /etc/nginx/ssl/polyp.key -out /etc/nginx/ssl/polyp.crt \
    -subj "/CN=$PUBLIC_HOST" -addext "subjectAltName=$SAN" 2>/dev/null
  echo "Self-signed. For a trusted cert, point a DNS name here and run:"
  echo "  certbot --nginx -d your.domain"
fi

say "Configuring nginx"
sed -e "s|__BACKEND_PORT__|$BACKEND_PORT|g" -e "s|__FRONTEND_PORT__|$FRONTEND_PORT|g" \
    "$APP_DIR/deploy/nginx-polyp.conf" > /etc/nginx/sites-available/polyp.conf
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/polyp.conf /etc/nginx/sites-enabled/polyp.conf
nginx -t
systemctl enable -q nginx
systemctl restart nginx

# --- 8. services -------------------------------------------------------------
say "Installing systemd units"
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__VENV_DIR__|$VENV_DIR|g" -e "s|__PORT__|$BACKEND_PORT|g" \
    "$APP_DIR/deploy/polyp-backend.service" > /etc/systemd/system/polyp-backend.service
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__PORT__|$FRONTEND_PORT|g" \
    "$APP_DIR/deploy/polyp-frontend.service" > /etc/systemd/system/polyp-frontend.service
systemctl daemon-reload
systemctl enable -q polyp-backend polyp-frontend
systemctl restart polyp-backend polyp-frontend

# --- 9. firewall -------------------------------------------------------------
# SSH first, always — enabling ufw before allowing the (possibly non-standard)
# SSH port locks everyone out of the box permanently.
say "Firewall: allowing SSH on $SSH_PORT, plus 80/443"
ufw allow "$SSH_PORT"/tcp comment 'ssh' >/dev/null
ufw allow 80/tcp  comment 'http' >/dev/null
ufw allow 443/tcp comment 'https' >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
ufw status verbose

# --- 10. verify --------------------------------------------------------------
say "Verifying"
for i in $(seq 1 30); do
  curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 && break
  sleep 2
done
echo -n "  backend  /health      : "; curl -fsS --max-time 10 "http://127.0.0.1:$BACKEND_PORT/health"; echo
echo -n "  backend  /api/backends: "; curl -fsS --max-time 10 "http://127.0.0.1:$BACKEND_PORT/api/backends"; echo
echo -n "  frontend via nginx    : "; curl -fsSk -o /dev/null -w '%{http_code}\n' --max-time 15 https://127.0.0.1/

cat <<DONE

Done.  Open:  https://$PUBLIC_HOST/

The certificate is self-signed, so the browser will warn once — that is expected.
If the app loads but inference is slow, check that the client is not on a VPN
routing out of the country and back.
DONE
