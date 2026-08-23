#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

required_files=(
  "$repo_root/src/studio-recorder.js"
  "$repo_root/src/recorder.css"
  "$repo_root/src/post-editor.css"
  "$repo_root/src/post-editor.js"
  "$repo_root/src/editor-core.js"
  "$repo_root/src/editor-store.js"
  "$repo_root/src/editor-io.js"
  "$repo_root/src/rough-cut-core.js"
  "$repo_root/src/smart-camera-core.js"
  "$repo_root/src/native-bridge.js"
  "$repo_root/server/no-cache-server.js"
  "$repo_root/server/render-core.js"
  "$repo_root/server/render_caption_overlays.py"
  "$repo_root/server/transcribe_audio.py"
  "$repo_root/native/capture-agent/macos/Package.swift"
  "$repo_root/native/capture-agent/macos/Sources/ExcalicordCaptureAgent/CaptureEngine.swift"
  "$repo_root/native/capture-agent/macos/Sources/ExcalicordCaptureAgent/Models.swift"
  "$repo_root/scripts/deploy-capture-agent.sh"
  "$repo_root/scripts/setup-local-asr.sh"
  "$repo_root/scripts/smoke-render-v011.js"
  "$repo_root/package.json"
  "$repo_root/README.md"
  "$repo_root/CHANGELOG.md"
  "$repo_root/scripts/env.sh"
  "$repo_root/scripts/preflight.sh"
  "$repo_root/scripts/configure-local.sh"
  "$repo_root/docs/quickstart.zh-CN.md"
  "$repo_root/docs/install.zh-CN.md"
  "$repo_root/docs/troubleshooting.zh-CN.md"
  "$repo_root/docs/project-format.zh-CN.md"
  "$repo_root/docs/v0.1.1-ux-review.zh-CN.md"
  "$repo_root/schemas/project-excalicord-v2.schema.json"
)

for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "missing: $file"
    exit 1
  fi
done

for runtime_module in editor-core.js editor-store.js editor-io.js rough-cut-core.js smart-camera-core.js post-editor.js; do
  if ! grep -q "src/$runtime_module" "$repo_root/scripts/deploy-local.sh"; then
    echo "deploy script missing editor runtime module injection: $runtime_module"
    exit 1
  fi
done
for render_file in render-core.js render_caption_overlays.py transcribe_audio.py; do
  if ! grep -q "server/$render_file" "$repo_root/scripts/deploy-local.sh"; then
    echo "deploy script missing local post-production component: $render_file"
    exit 1
  fi
done
if ! grep -q 'recorder\.css.*post-editor\.css.*editor-core\.js.*editor-store\.js.*editor-io\.js.*rough-cut-core\.js.*smart-camera-core\.js.*native-bridge\.js.*studio-recorder\.js.*post-editor\.js' "$repo_root/scripts/deploy-local.sh"; then
  echo "deploy script does not preserve M3 CSS/JS order"
  exit 1
fi
for project_api in projectV2 projectV2ToLegacyRuntime mergeLegacyRuntimeIntoProjectV2 normalizeProject migrateV1; do
  if ! grep -q "$project_api" "$repo_root/src/studio-recorder.js"; then
    echo "schema v2 project API contract missing: $project_api"
    exit 1
  fi
done
if ! grep -q 'PROJECT_FILE_SCHEMA = 2' "$repo_root/src/studio-recorder.js"; then
  echo "project file schema v2 contract missing"
  exit 1
fi
if ! grep -q 'v011BeginProjectAtNewRoot' "$repo_root/src/studio-recorder.js"; then
  echo "new project root isolation contract missing"
  exit 1
fi
if ! grep -q '请先设置项目文件夹，再开始录制' "$repo_root/src/studio-recorder.js"; then
  echo "recording must require one explicit project root"
  exit 1
fi
for editor_hook in getProjectV2 saveEditorProject getLastRecordingBlob saveProjectTextAsset; do
  if ! grep -q "$editor_hook" "$repo_root/src/studio-recorder.js"; then
    echo "post-editor debug hook missing: $editor_hook"
    exit 1
  fi
done
if ! grep -q 'excalicord:recording-ready' "$repo_root/src/studio-recorder.js"; then
  echo "recording-ready event dispatch contract missing"
  exit 1
fi
if ! grep -q 'planFromEvents' "$repo_root/src/studio-recorder.js"; then
  echo "smart camera core integration missing"
  exit 1
fi
if grep -q '进入录后编辑' "$repo_root/src/studio-recorder.js"; then
  echo "studio-recorder must not mount a duplicate post-editor button"
  exit 1
fi

if [ -f "$repo_root/SKILL.md" ] || [ -f "$repo_root/agents/openai.yaml" ]; then
  echo "unexpected automation metadata found; remove SKILL.md and agents/openai.yaml"
  exit 1
fi

if find "$repo_root" -path "$repo_root/examples" -prune -o \( -name "scene.excalidraw" -o -name "scene.json" \) -print | grep -q .; then
  echo "scene files must not be committed"
  exit 1
fi

if grep -nE "title=.*Frame|aria-label.*Frame|toast\\([^)]*Frame|confirm\\([^)]*Frame|prompt\\([^)]*Frame" "$repo_root/src/studio-recorder.js" >/dev/null 2>&1; then
  echo "user-facing Frame wording may remain in src/"
  exit 1
fi

project_folder_controls="$(grep -o 'id="ec-project-folder-choose"' "$repo_root/src/studio-recorder.js" | wc -l | tr -d " ")"
if [ "$project_folder_controls" != "1" ]; then
  echo "expected exactly one project folder selector, found $project_folder_controls"
  exit 1
fi
for project_control in ec-project-folder-path ec-project-folder-open ec-project-file-open ec-project-file-input ec-project-whiteboard-save; do
  control_count="$(grep -o "id=\"$project_control\"" "$repo_root/src/studio-recorder.js" | wc -l | tr -d " ")"
  if [ "$control_count" != "1" ]; then
    echo "expected exactly one explicit project control $project_control, found $control_count"
    exit 1
  fi
done
if grep -q '项目根' "$repo_root/src/studio-recorder.js"; then
  echo "recording panel must use 项目 instead of 项目根"
  exit 1
fi
if grep -q 'id="ec-project-whiteboard-open"' "$repo_root/src/studio-recorder.js"; then
  echo "legacy project-folder loading button remains visible"
  exit 1
fi
for recording_panel_contract in \
  'id="ec-mic-device"' \
  'id="ec-cursor-highlight-style"' \
  'id="ec-cursor-shape"' \
  'id="ec-cursor-sound"' \
  'id="ec-screen-light-toggle"' \
  '镜头补光' \
  '增强摄像头亮度' \
  '屏幕柔光' \
  '显示补光圈' \
  '人像优化' \
  '启用调节' \
  '亮肤' \
  '肤色冷暖' \
  '饱和度' \
  'id="ec-mini-recorder"' \
  '屏幕/窗口录制会记录鼠标停留和点击；录后可生成并调整聚焦镜头，幻灯片聚焦仅用于白板。'; do
  if ! grep -q "$recording_panel_contract" "$repo_root/src/studio-recorder.js"; then
    echo "recording panel UX contract missing: $recording_panel_contract"
    exit 1
  fi
done
if grep -q '磨皮美白' "$repo_root/src/studio-recorder.js"; then
  echo "beauty toggle label must cover all portrait controls, not only smoothing/whitening"
  exit 1
fi
if grep -qE '虚拟补光|屏幕补光' "$repo_root/src/studio-recorder.js"; then
  echo "lighting labels must distinguish camera-only fill light from screen soft light"
  exit 1
fi
for recording_panel_css in \
  '.ec-whiteboard-actions' \
  '.ec-cursor-options' \
  '.ec-mini-recorder' \
  '.ec-screen-light' \
  '.ec-cursor-style-spotlight' \
  '.ec-cursor-shape-crosshair'; do
  if ! grep -q "$recording_panel_css" "$repo_root/src/recorder.css"; then
    echo "recording panel CSS contract missing: $recording_panel_css"
    exit 1
  fi
done
for user_contract in \
  '设置项目文件夹…' \
  '在 Finder 中显示' \
  '打开 Excalidraw 文件…' \
  '保存白板' \
  '保存录制' \
  '打开保存位置' \
  '播放原始录制' \
  '原始录制已就绪'; do
  if ! grep -q "$user_contract" "$repo_root/src/studio-recorder.js"; then
    echo "user-facing M0 contract missing: $user_contract"
    exit 1
  fi
done
if grep -q '文字轨' "$repo_root/src/studio-recorder.js"; then
  echo "legacy standalone 文字轨 section remains in studio-recorder.js"
  exit 1
fi
for script_contract in \
  '载入讲稿文件…' \
  '讲稿在提词器面板内载入或编辑；录后的逐字稿和字幕仍以实际音频为准'; do
  if ! grep -q "$script_contract" "$repo_root/src/studio-recorder.js"; then
    echo "script preparation contract missing: $script_contract"
    exit 1
  fi
done
if grep -q 'id="ec-script-import"' "$repo_root/src/studio-recorder.js"; then
  echo "duplicate script import button remains in recording panel"
  exit 1
fi
if grep -qE '保存 SRT|用字幕载入提词器|id="ec-subtitle-(import|export|file)"|id="ec-subtitle-to-script"' "$repo_root/src/studio-recorder.js"; then
  echo "recording-prep subtitle-track controls remain visible in studio-recorder.js"
  exit 1
fi
if grep -n -A35 'scriptImportFileInput.addEventListener' "$repo_root/src/studio-recorder.js" | grep -q 'v011SetSubtitleTrack'; then
  echo "SRT/VTT script import must not write the subtitle track"
  exit 1
fi
if grep -qE 'id="ec-save-folder|more-excalicord-subtitles\\.srt|downloadBlobWithBrowser' "$repo_root/src/studio-recorder.js"; then
  echo "legacy recording-folder or browser-download path remains in studio-recorder.js"
  exit 1
fi
for project_path in project.excalicord.json scene.excalidraw recordings/ text/subtitles.srt; do
  if ! grep -q "$project_path" "$repo_root/src/studio-recorder.js"; then
    echo "project path contract missing from studio-recorder.js: $project_path"
    exit 1
  fi
done
for recording_contract in \
  'sessionId' \
  'recordings/" + (state.rec.sessionId' \
  'recordings/" + pathParts[1] + "/session.json' \
  'recordings/" + pathParts[1] + "/events.json' \
  'timebase: "recording-start"' \
  'recording.limitations' \
  'recording.assets.webcam = null' \
  'recording.assets.microphone = null' \
  'recording.assets.systemAudio = null'; do
  if ! grep -Fq "$recording_contract" "$repo_root/src/studio-recorder.js"; then
    echo "recording session/schema contract missing: $recording_contract"
    exit 1
  fi
done
for native_asset in \
  'text/transcript.raw.json' \
  'text/transcript.corrected.json' \
  'text/transcript.corrections.json' \
  'text/subtitles.srt' \
  'text/subtitles.vtt' \
  'session.json' \
  'events.json'; do
  if ! grep -q "$native_asset" "$repo_root/README.md"; then
    echo "native asset whitelist documentation missing: $native_asset"
    exit 1
  fi
done

capture_agent_root="$repo_root/native/capture-agent/macos/Sources/ExcalicordCaptureAgent"
if [ -f "$capture_agent_root/CaptureEngine.swift" ]; then
  for native_asset in \
    'text/transcript.raw.json' \
    'text/transcript.corrected.json' \
    'text/transcript.corrections.json' \
    'text/subtitles.srt' \
    'text/subtitles.vtt'; do
    if ! grep -q "$native_asset" "$capture_agent_root/CaptureEngine.swift"; then
      echo "capture agent whitelist missing: $native_asset"
      exit 1
    fi
  done
  if ! grep -q 'isSafeSessionId' "$capture_agent_root/CaptureEngine.swift" || \
     ! grep -q 'sessionId' "$capture_agent_root/Models.swift"; then
    echo "capture agent session directory contract missing"
    exit 1
  fi
fi

package_version="$(node -e "console.log(require(process.argv[1]).version)" "$repo_root/package.json")"
display_version="v$package_version"
if ! grep -q "$display_version" "$repo_root/README.md"; then
  echo "README.md does not mention $display_version"
  exit 1
fi
if ! grep -q "$display_version" "$repo_root/CHANGELOG.md"; then
  echo "CHANGELOG.md does not mention $display_version"
  exit 1
fi

css_open="$(grep -o "{" "$repo_root/src/recorder.css" | wc -l | tr -d " ")"
css_close="$(grep -o "}" "$repo_root/src/recorder.css" | wc -l | tr -d " ")"
if [ "$css_open" != "$css_close" ]; then
  echo "css brace mismatch: $css_open/$css_close"
  exit 1
fi

echo "check ok"
