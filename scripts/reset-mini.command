#!/bin/bash
set -euo pipefail

name='LingoWeave Mini'
channel='正式版'
identifier='com.lingoweave.mini'
if [[ "$#" == 1 && "$1" == --dev ]]; then
  name='LingoWeave Mini Dev'
  channel='Dev 开发版'
  identifier='com.lingoweave.mini.dev'
elif [[ "$#" != 0 ]]; then
  printf '用法：%s [--dev]\n' "$0" >&2
  exit 2
fi

here="$(cd -- "$(dirname -- "$0")" && pwd -P)"
if [[ -f "$here/package-mini-service.mjs" && -d "$here/../apps/macos/dist" ]]; then
  here="$here/../apps/macos/dist"
fi
app="$here/$name.app"
helper_id="$identifier"
# The explicit --dev target is independent of which bundle supplies the tool.
if [[ "$identifier" == 'com.lingoweave.mini.dev' && ! -f "$app/Contents/Resources/service/scripts/mini-reset.mjs" ]]; then
  app="$here/LingoWeave Mini.app"
  helper_id='com.lingoweave.mini'
fi
service="$app/Contents/Resources/service"
if [[ ! -x "$service/runtime/node" || ! -f "$service/scripts/mini-reset.mjs" || ! -f "$service/scripts/mini-service.mjs" ]] ||
   [[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" != "$helper_id" ]] ||
   ! /usr/bin/codesign --verify --strict "$app"; then
  printf '请将这个脚本放在签名完整、支持重置的 LingoWeave Mini 应用旁边。\n' >&2
  exit 1
fi

answer="$(/usr/bin/osascript - "$channel" <<'ASK'
on run argv
  set channel to item 1 of argv
  try
    display dialog ("重置 LingoWeave Mini " & channel & "？" & return & return & "将退出该版本，永久清除学习进度、计划、句式练习、聊天、草稿、生成的例句及音频，并还原设置。" & return & return & "保留词书、自定义词表、原文素材和已安装模型，不影响另一个版本。") buttons {"取消", "退出并清空"} default button "取消" cancel button "取消" with icon caution with title "重置学习数据"
    return button returned of result
  on error number -128
    return "取消"
  end try
end run
ASK
)"
[[ "$answer" == '退出并清空' ]] || exit 0
if [[ "$channel" == '正式版' ]]; then
  exec "$service/runtime/node" "$service/scripts/mini-service.mjs" --reset-study --confirm
fi
exec "$service/runtime/node" "$service/scripts/mini-service.mjs" --dev --reset-study --confirm
