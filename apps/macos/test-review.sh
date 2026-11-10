#!/bin/bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/lingoweave-review.XXXXXX")"
binary="$temporary_dir/MiniReviewTests"
daily_binary="$temporary_dir/MiniDailyStudyTests"
cleanup() {
  /bin/rm -f -- "$binary" "$daily_binary"
  /bin/rmdir -- "$temporary_dir"
}
trap cleanup EXIT

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/MiniReviewTests.swift" \
  -o "$binary"
"$binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/MiniDailyStudyTests.swift" \
  -o "$daily_binary"
"$daily_binary"
