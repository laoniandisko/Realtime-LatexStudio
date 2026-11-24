#!/bin/sh
# macOS Finder entry point. Keep failures visible in the Terminal window.
case $0 in */*) studio_dir=${0%/*} ;; *) studio_dir=. ;; esac
studio_root=$(CDPATH= cd -- "$studio_dir" && pwd) || exit 1
/bin/sh "$studio_root/Start-LaTeXStudio.sh" "$@"
studio_status=$?
if [ "$studio_status" -ne 0 ] && [ -t 0 ]; then
  printf '\n%s' 'Startup failed. Press Enter to close this window: '
  read -r studio_reply
fi
exit "$studio_status"
