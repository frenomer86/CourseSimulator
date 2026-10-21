#!/usr/bin/env bash
# One-time host setup for CS Virtual Lab on an Ubuntu 22.04/24.04 VPS. Idempotent: safe to re-run.
# Usage (as root on the VPS):  bash setup-vps.sh <git-repo-url> <domain>
# It installs Docker, age, rsync, ufw and unattended upgrades, clones the repository into
# /opt/cs-virtual-lab, writes .env with generated secrets, and prints what to do next.
set -euo pipefail

REPO_URL="${1:?git repository url}"
DOMAIN="${2:?domain name (or http://<ip> while you have no domain)}"
APP_DIR=/opt/cs-virtual-lab

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git ufw unattended-upgrades age rsync jq

# Docker (official convenience script; idempotent).
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Security updates install themselves; reboots stay manual.
dpkg-reconfigure -f noninteractive unattended-upgrades
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# Swap: the web build needs more memory than a small VPS has; 2 GB of swap keeps the build alive.
if [ "$(free -m | awk '/^Mem:/ {print $2}')" -lt 4000 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Firewall: SSH, HTTP, HTTPS only.
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# The application checkout.
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# Secrets: generated once, never printed. RESEARCH_SALT must never change afterwards.
if [ ! -f .env ]; then
  umask 077
  cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-40)
DOMAIN=$DOMAIN
RESEARCH_SALT=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-56)
BACKUP_KEEP_DAYS=30
BACKUP_AGE_RECIPIENT=
BACKUP_SSH_TARGET=
EOF
  echo "Wrote $APP_DIR/.env (mode 600). Back up RESEARCH_SALT somewhere safe; it must never change."
fi

mkdir -p /var/backups/cs-virtual-lab
chmod 700 /var/backups/cs-virtual-lab

echo
echo "Host ready. Next:"
echo "  1. cd $APP_DIR && docker compose up -d --build"
echo "  2. bash scripts/ops/install-backups.sh     (creates the age key and the nightly job)"
echo "  3. Point the DNS A record for $DOMAIN at this server, then open https://$DOMAIN/"
