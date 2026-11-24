#!/bin/bash
set -euo pipefail

usage() {
  printf 'Usage: %s [--dev] [--open]\n' "$0"
}

launch=false
configuration=release
for argument in "$@"; do
  case "$argument" in
    --dev) configuration=debug ;;
    --open) launch=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
project_dir="$(cd -- "$script_dir/../.." && pwd -P)"
build_node="$(command -v node)"
sdk_path="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
sdk_version="$(xcrun --sdk "$sdk_path" --show-sdk-version)"
minimum_macos="$(/usr/bin/plutil -extract LSMinimumSystemVersion raw -o - "$script_dir/Info.plist")"
pnpm --dir "$project_dir" --filter @lingoweave/contracts build
pnpm --dir "$project_dir" --filter @lingoweave/server build
dist_dir="$script_dir/dist"
app_name="LingoWeave Mini"
if [ "$configuration" = debug ]; then
  app_name="LingoWeave Mini Dev"
fi
app_bundle="$dist_dir/$app_name.app"

# Swift Build can otherwise pass the deployment target as the linked SDK version.
# AppKit uses that SDK version to select the native window controls.
swift_build=(
  swift build --package-path "$script_dir" --configuration "$configuration" --sdk "$sdk_path"
  -Xlinker -platform_version -Xlinker macos -Xlinker "$minimum_macos" -Xlinker "$sdk_version"
)
"${swift_build[@]}"
bin_dir="$("${swift_build[@]}" --show-bin-path)"

mkdir -p "$dist_dir"
staging_dir="$(mktemp -d "$dist_dir/.build-app.XXXXXX")"
trap 'rm -rf -- "$staging_dir"' EXIT
staged_app="$staging_dir/$app_name.app"
mkdir -p "$staged_app/Contents/MacOS"
cp "$bin_dir/LingoWeaveMini" "$staged_app/Contents/MacOS/LingoWeaveMini"
"$build_node" "$project_dir/scripts/package-mini-service.mjs" "$staged_app/Contents/Resources/service"
iconset="$staging_dir/app-icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$script_dir/assets/app-icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  retina_size=$((size * 2))
  /usr/bin/sips -z "$retina_size" "$retina_size" "$script_dir/assets/app-icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset" -o "$staged_app/Contents/Resources/app-icon.icns"
plist="$staged_app/Contents/Info.plist"
cp "$script_dir/Info.plist" "$plist"
service_port=4312
if [ "$configuration" = debug ]; then
  service_port=4311
  /usr/bin/plutil -replace CFBundleIdentifier -string com.lingoweave.mini.dev "$plist"
  /usr/bin/plutil -replace CFBundleName -string "$app_name" "$plist"
  /usr/bin/plutil -replace CFBundleDisplayName -string "$app_name" "$plist"
fi
/usr/bin/plutil -replace CFBundleExecutable -string launch "$plist"
/usr/bin/plutil -insert LingoWeaveServiceURL -string "http://127.0.0.1:$service_port" "$plist"
/usr/bin/plutil -insert LingoWeaveServiceDevelopment -bool "$([ "$configuration" = debug ] && echo true || echo false)" "$plist"
cat > "$staged_app/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/bash
set -u
mini_bin_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
mini_plist="$mini_bin_dir/../Info.plist"
mini_service="$(cd -- "$mini_bin_dir/../Resources/service" && pwd -P)"
mini_node="$mini_service/runtime/node"
mini_launcher="$mini_service/scripts/mini-service.mjs"
mini_development="$(/usr/bin/plutil -extract LingoWeaveServiceDevelopment raw -o - "$mini_plist")"
if [ -z "${CODEX_BIN:-}" ]; then
  mini_codex="$(/usr/bin/plutil -extract LingoWeaveCodexPath raw -o - "$mini_plist" 2>/dev/null || true)"
  if [ -n "$mini_codex" ] && [ -x "$mini_codex" ]; then
    export CODEX_BIN="$mini_codex"
  fi
fi
if [ "$mini_development" = true ]; then
  "$mini_node" "$mini_launcher" --dev || true
else
  "$mini_node" "$mini_launcher" || true
fi
exec "$mini_bin_dir/LingoWeaveMini"
LAUNCH
chmod +x "$staged_app/Contents/MacOS/launch"

codex_path="${CODEX_BIN:-}"
if [ -n "$codex_path" ]; then
  if [[ "$codex_path" != /* ]]; then
    codex_path="$(command -v "$codex_path" || true)"
  fi
  if [[ "$codex_path" != /* || ! -x "$codex_path" ]]; then
    printf 'CODEX_BIN must resolve to an executable file.\n' >&2
    exit 1
  fi
else
  codex_path="$(command -v codex || true)"
  if [[ ! -x "$codex_path" && -x /Applications/Codex.app/Contents/Resources/codex ]]; then
    codex_path=/Applications/Codex.app/Contents/Resources/codex
  fi
fi
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
