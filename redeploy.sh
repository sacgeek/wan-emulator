#!/bin/bash
# Run this on the Docker host to force a clean rebuild and redeploy
# Usage: bash redeploy.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Pulling latest code from git..."
git pull

echo "==> Stopping existing container..."
docker compose down

echo "==> Rebuilding image with no cache (CACHEBUST=$(date +%s))..."
CACHEBUST=$(date +%s) docker compose build --no-cache

echo "==> Starting updated container..."
docker compose up -d

echo "==> Done. Container status:"
docker compose ps
