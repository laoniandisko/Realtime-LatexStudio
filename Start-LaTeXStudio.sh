#!/bin/sh
# Run from any working directory; Finder often omits Homebrew from PATH.
case $0 in */*) studio_dir=${0%/*} ;; *) studio_dir=. ;; esac
studio_root=$(CDPATH= cd -- "$studio_dir" && pwd) || exit 1
PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 22.11 or newer is required. Install an LTS release from https://nodejs.org/ and try again.' >&2
  exit 1
fi
exec node "$studio_root/scripts/launch/start-studio.mjs" "$@"
