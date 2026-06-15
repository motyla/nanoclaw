#!/usr/bin/env bash
# Garmin data-layer install — wires Garmin sync into this nanoclaw fork.
# Run as your regular user from the repo root:
#   bash setup/garmin/install.sh
#
# Prereqs:
#   * nanoclaw already installed, running, and paired with Telegram
#   * .env filled in (see setup/garmin/env.example for the vars to add)
#
# What it does:
#   1. Python venv + garmin-health-data (in setup/garmin/.venv)
#   2. Deploys query.js + Garmin CLAUDE.local.md section into the agent group folder
#   3. Installs the `garmin-sync` command to ~/.local/bin
#   4. Optionally pins the agent model (if NANOCLAW_GROUP_ID is set)
set -euo pipefail

FORK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GARMIN_DIR="${FORK_DIR}/setup/garmin"

echo "=== Load .env ==="
[ -f "${FORK_DIR}/.env" ] || { echo "missing ${FORK_DIR}/.env (see setup/garmin/env.example for vars to add)"; exit 1; }
# shellcheck disable=SC1091
. "${FORK_DIR}/.env"
for var in GARMIN_EMAIL GARMIN_PASSWORD NANOCLAW_GROUP_FOLDER; do
    [ -n "${!var:-}" ] || { echo "missing ${var} in .env (see setup/garmin/env.example)"; exit 1; }
done
chmod 600 "${FORK_DIR}/.env"

GROUP_DIR="${FORK_DIR}/groups/${NANOCLAW_GROUP_FOLDER}"
[ -d "${GROUP_DIR}" ] || { echo "group folder not found: ${GROUP_DIR} — is nanoclaw set up? (see: ncl groups list)"; exit 1; }
echo "  group folder: ${GROUP_DIR}"

echo "=== Python venv + garmin-health-data ==="
python3 -m venv "${GARMIN_DIR}/.venv"
"${GARMIN_DIR}/.venv/bin/pip" install --upgrade pip
"${GARMIN_DIR}/.venv/bin/pip" install -r "${GARMIN_DIR}/requirements.txt"

echo "=== Deploy agent query helper + instructions ==="
cp "${GARMIN_DIR}/agent/query.js" "${GROUP_DIR}/query.js"
if ! grep -q '## Garmin fitness data' "${GROUP_DIR}/CLAUDE.local.md" 2>/dev/null; then
    cat "${GARMIN_DIR}/agent/garmin-instructions.md" >> "${GROUP_DIR}/CLAUDE.local.md"
    echo "  appended Garmin section to CLAUDE.local.md"
else
    echo "  CLAUDE.local.md already has the Garmin section — left as-is"
fi

echo "=== Install garmin-sync command ==="
mkdir -p "${HOME}/.local/bin"
sed -e "s#__VENV__#${GARMIN_DIR}/.venv#g" \
    -e "s#__GROUP_DIR__#${GROUP_DIR}#g" \
    "${GARMIN_DIR}/garmin-sync" > "${HOME}/.local/bin/garmin-sync"
chmod +x "${HOME}/.local/bin/garmin-sync"
echo "  installed: ${HOME}/.local/bin/garmin-sync"
case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) echo "  note: ~/.local/bin is not on PATH — add it to ~/.bashrc" ;;
esac

echo "=== Pin agent model ==="
if [ -n "${NANOCLAW_GROUP_ID:-}" ]; then
    ncl groups config update --id "${NANOCLAW_GROUP_ID}" --model "${MODEL:-haiku}" || \
        echo "  could not set model (run manually if needed)"
else
    echo "  NANOCLAW_GROUP_ID not set — skipping (run: ncl groups list, then ncl groups config update --id <id> --model haiku)"
fi

echo ""
echo "=== Done ==="
echo "Next:"
echo "  source .env && setup/garmin/.venv/bin/garmin auth --email \"\$GARMIN_EMAIL\" --password \"\$GARMIN_PASSWORD\"   # one-time login (MFA)"
echo "  garmin-sync                                                                                                     # first pull"
