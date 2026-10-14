#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  echo 'Do not run the everyday RabiRoute Linux Host as root.' >&2
  exit 1
fi
command -v node >/dev/null || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
command -v flock >/dev/null || { echo 'util-linux flock is required.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
if ! command -v xdg-open >/dev/null; then
  echo 'Note: xdg-open is not on PATH; install xdg-utils if you want Host --command open to launch a browser.' >&2
fi
npm ci
npm run build
exec node scripts/linux-host.mjs "$@"
