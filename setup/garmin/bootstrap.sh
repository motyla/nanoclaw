#!/usr/bin/env bash
# Root host prep — run once on a fresh VM before installing nanoclaw.
#   sudo bash setup/garmin/bootstrap.sh
#
# Installs the few host packages we need (nanoclaw installs Node/Docker/bun
# itself) and adds swap so a 2 GB e2-small can run the agent.
# Idempotent: safe to re-run.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo bash setup/garmin/bootstrap.sh"; exit 1; }

SWAP_SIZE="${SWAP_SIZE:-2G}"
SWAPFILE="/swapfile"

echo "=== Packages (git, python venv) ==="
apt-get update
apt-get install -y git python3 python3-venv

echo "=== Swap (${SWAP_SIZE}) ==="
if swapon --show --noheadings | grep -q .; then
    echo "  swap already active — skipping"
else
    fallocate -l "${SWAP_SIZE}" "${SWAPFILE}" || dd if=/dev/zero of="${SWAPFILE}" bs=1M count="$(( ${SWAP_SIZE%G} * 1024 ))"
    chmod 600 "${SWAPFILE}"
    mkswap "${SWAPFILE}"
    swapon "${SWAPFILE}"
    grep -q "^${SWAPFILE} " /etc/fstab || echo "${SWAPFILE} none swap sw 0 0" >> /etc/fstab
    echo "  created and enabled ${SWAPFILE}"
fi

echo ""
free -h
echo ""
echo "=== Done — next: install nanoclaw, then run setup/garmin/install.sh as your user ==="
