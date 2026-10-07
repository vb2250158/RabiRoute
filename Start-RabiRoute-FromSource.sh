#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
command -v flock >/dev/null || { echo 'util-linux flock is required.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
npm ci
npm run build
exec node scripts/linux-host.mjs "$@"
