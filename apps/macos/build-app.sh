#!/bin/bash
set -euo pipefail

usage() {
  printf 'Usage: %s [--open]\n' "$0"
}

launch=false
case "${1-}" in
  '') ;;
  --open) launch=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
dist_dir="$script_dir/dist"
app_bundle="$dist_dir/LingoWeave Mini.app"

swift build --package-path "$script_dir" --configuration release
bin_dir="$(swift build --package-path "$script_dir" --configuration release --show-bin-path)"

mkdir -p "$dist_dir"
staging_dir="$(mktemp -d "$dist_dir/.build-app.XXXXXX")"
trap 'rm -rf -- "$staging_dir"' EXIT
staged_app="$staging_dir/LingoWeave Mini.app"
mkdir -p "$staged_app/Contents/MacOS"
cp "$bin_dir/LingoWeaveMini" "$staged_app/Contents/MacOS/LingoWeaveMini"
plist="$staged_app/Contents/Info.plist"
cp "$script_dir/Info.plist" "$plist"

codex_path="$(command -v codex || true)"
if [[ "$codex_path" = /* && -x "$codex_path" ]]; then
  /usr/bin/plutil -insert LingoWeaveCodexPath -string "$codex_path" "$plist"
fi
/usr/bin/plutil -lint "$plist"
/usr/bin/codesign --force --sign - "$staged_app"
/usr/bin/codesign --verify --strict "$staged_app"

previous_app="$staging_dir/previous.app"
if [ -e "$app_bundle" ]; then
  mv "$app_bundle" "$previous_app"
fi
if ! mv "$staged_app" "$app_bundle"; then
  if [ -e "$previous_app" ]; then
    mv "$previous_app" "$app_bundle"
  fi
  exit 1
fi

printf 'Built %s\n' "$app_bundle"
if $launch; then
  /usr/bin/open "$app_bundle"
fi
