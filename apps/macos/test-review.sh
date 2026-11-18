#!/bin/bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/lingoweave-review.XXXXXX")"
binary="$temporary_dir/MiniReviewTests"
daily_binary="$temporary_dir/MiniDailyStudyTests"
dev_binary="$temporary_dir/MiniDevPreviewTests"
client_binary="$temporary_dir/mini-study-client-tests"
ai_binary="$temporary_dir/mini-ai-client-tests"
audio_binary="$temporary_dir/mini-audio-client-tests"
practice_binary="$temporary_dir/mini-practice-client-tests"
memory_binary="$temporary_dir/mini-memory-client-tests"
interaction_binary="$temporary_dir/mini-card-interaction-tests"
cleanup() {
  /bin/rm -f -- "$binary" "$daily_binary" "$dev_binary" "$client_binary" "$ai_binary" "$audio_binary" "$practice_binary" "$memory_binary" "$interaction_binary"
  /bin/rmdir -- "$temporary_dir"
}
trap cleanup EXIT

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/MiniReviewTests.swift" \
  -o "$binary"
"$binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/MiniDailyStudyTests.swift" \
  -o "$daily_binary"
"$daily_binary"

swiftc -swift-version 6 -D DEBUG \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDevPreview.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/MiniDevPreviewTests.swift" \
  -o "$dev_binary"
"$dev_binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReviewStorage.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-plan.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-practice.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-study-client.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-assessment-client.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/mini-study-client-tests.swift" \
  -o "$client_binary"
"$client_binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReviewStorage.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-plan.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-practice.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-study-client.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniChatService.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniChatStorage.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyAI.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-ai-client.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/mini-ai-client-tests.swift" \
  -o "$ai_binary"
"$ai_binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReviewStorage.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-plan.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-practice.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-study-client.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-audio-client.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-audio-controller.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/mini-audio-client-tests.swift" \
  -o "$audio_binary"
"$audio_binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReviewStorage.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-plan.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-study-client.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-practice.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-vocabulary-client.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/mini-practice-client-tests.swift" \
  -o "$practice_binary"
"$practice_binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReviewStorage.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-plan.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-practice.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-study-client.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-memory-client.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/mini-memory-client-tests.swift" \
  -o "$memory_binary"
"$memory_binary"

swiftc -swift-version 6 \
  "$script_dir/Sources/LingoWeaveMini/MiniWord.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReview.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-flow.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniDailyStudy.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReviewStorage.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-plan.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-practice.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-study-client.swift" \
  "$script_dir/Sources/LingoWeaveMini/MiniReviewView.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-practice-view.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-audio-footer.swift" \
  "$script_dir/Sources/LingoWeaveMini/mini-window-controls.swift" \
  "$script_dir/Tests/LingoWeaveMiniTests/mini-card-interaction-tests.swift" \
  -o "$interaction_binary"
"$interaction_binary"
