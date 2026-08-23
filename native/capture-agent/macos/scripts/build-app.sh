#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_DIR=${SCRIPT_DIR:h}
DIST_DIR="$PROJECT_DIR/dist"
APP_DIR="$DIST_DIR/Excalicord Capture.app"
EXECUTABLE="$PROJECT_DIR/.build/release/ExcalicordCaptureAgent"

cd "$PROJECT_DIR"
swift build -c release

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$EXECUTABLE" "$APP_DIR/Contents/MacOS/ExcalicordCaptureAgent"

cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Excalicord Capture</string>
  <key>CFBundleExecutable</key><string>ExcalicordCaptureAgent</string>
  <key>CFBundleIdentifier</key><string>com.excalicord.capture-agent</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Excalicord Capture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>将摄像头画面叠加到桌面录制视频中。</string>
  <key>NSMicrophoneUsageDescription</key><string>在桌面录制视频中加入讲解声音。</string>
</dict>
</plist>
PLIST

# Keep a stable designated requirement for local ad-hoc builds. Without this,
# every rebuild is identified only by a new code hash and macOS can orphan the
# user's Screen Recording grant.
codesign --force --deep --sign - \
  --requirements '=designated => identifier "com.excalicord.capture-agent"' \
  "$APP_DIR"
echo "$APP_DIR"
