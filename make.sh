#!/usr/bin/env bash
# Build/version helper for the Database Client extension.
# Usage: ./make.sh <command> [arg]
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage: ./make.sh <command> [arg]

Versioning
  version            Print the current version
  major              Bump major  (1.2.3 -> 2.0.0)
  minor              Bump minor  (1.2.3 -> 1.3.0)
  patch              Bump patch  (1.2.3 -> 1.2.4)
  set <x.y.z>        Set an exact version

Build
  build              Bundle the extension into dist/
  typecheck          Run tsc --noEmit
  package            Typecheck, bundle and create database-client-<version>.vsix
  release <major|minor|patch>
                     Bump the version, then package
  install            Install the newest local .vsix into VS Code (code CLI)
  clean              Remove dist/ and all .vsix files
EOF
}

current() { node -p "require('./package.json').version"; }

bump() {
  # --no-git-tag-version: this is not necessarily a git repo, and we only want the file edit.
  npm.cmd version "$1" --no-git-tag-version --allow-same-version >/dev/null
  echo "Version: $(current)"
}

latest_vsix() {
  # Picked with node: `sort -V` is GNU-only and fails where Windows' sort.exe is first on PATH.
  node -e '
    const v = (f) => f.match(/database-client-(.+)\.vsix$/)[1].split(".").map(Number);
    const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (v(a)[i] || 0) - (v(b)[i] || 0); if (d) return d; } return 0; };
    const f = require("fs").readdirSync(".").filter((n) => /^database-client-[\d.]+\.vsix$/.test(n)).sort(cmp);
    if (f.length) console.log(f[f.length - 1]);
  '
}

cmd="${1:-}"
case "$cmd" in
  version) current ;;
  major | minor | patch) bump "$cmd" ;;
  set)
    [[ "${2:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "set needs x.y.z" >&2; exit 1; }
    bump "$2"
    ;;
  build) npm.cmd run build ;;
  typecheck) npm.cmd run typecheck ;;
  package) npm.cmd run package ;;
  release)
    case "${2:-}" in
      major | minor | patch) bump "$2"; npm.cmd run package ;;
      *) echo "release needs major, minor or patch" >&2; exit 1 ;;
    esac
    ;;
  install)
    vsix="$(latest_vsix)"
    [[ -n "$vsix" ]] || { echo "No .vsix found. Run ./make.sh package first." >&2; exit 1; }
    # `code` is a .cmd shim on Windows; prefer it when present.
    if command -v code.cmd >/dev/null 2>&1; then CODE=code.cmd; else CODE=code; fi
    "$CODE" --install-extension "$vsix" --force
    echo "Installed $vsix. Reload VS Code to use it."
    ;;
  clean) rm -rf dist database-client-*.vsix; echo "Cleaned." ;;
  reinstall)
    sh make.sh clean
    sh make.sh package
    sh make.sh install
    ;;
  "" | help | -h | --help) usage ;;
  *) echo "Unknown command: $cmd" >&2; usage >&2; exit 1 ;;
esac
