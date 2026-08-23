#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_DIR=${SCRIPT_DIR:h}
SOURCE_APP="$PROJECT_DIR/dist/Excalicord Capture.app"
INSTALL_ROOT="$HOME/Library/Application Support/Excalicord"
INSTALL_APP="$INSTALL_ROOT/Excalicord Capture.app"
PLIST="$HOME/Library/LaunchAgents/com.excalicord.capture-agent.plist"
LABEL="com.excalicord.capture-agent"

"$SCRIPT_DIR/build-app.sh" >/dev/null
mkdir -p "$INSTALL_ROOT" "$HOME/Library/LaunchAgents"

if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID/$LABEL" || true
fi

if [ -d "$INSTALL_APP" ]; then
  mv "$INSTALL_APP" "$INSTALL_ROOT/Excalicord Capture.backup-$(date +%Y%m%d-%H%M%S).app"
fi
cp -R "$SOURCE_APP" "$INSTALL_APP"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_APP/Contents/MacOS/ExcalicordCaptureAgent</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/excalicord-capture-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/excalicord-capture-agent.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"
echo "$INSTALL_APP"
