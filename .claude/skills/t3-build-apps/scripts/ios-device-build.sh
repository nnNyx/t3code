#!/usr/bin/env bash
# Build + install the STRIPPED (free personal-team) iOS preview app onto a
# connected iPhone, signed by the Personal Team currently logged into Xcode.
#
# IMPORTANT: run the PREP step (personal-team prebuild) once before this, and
# run this ONLY inside a GUI login session (see references/ios.md). Over plain
# SSH, xcodebuild reports "No Account for Team" even when Xcode has the account.
# Launch it from the GUI with e.g.:
#   osascript -e 'tell application "Terminal" to do script "~/.../ios-device-build.sh"'
#
# ============================ VARIABLES ====================================
# Owner (Mac) defaults shown — substitute for your machine + team + device.
REPO=${REPO:-$HOME/dev/t3code}
VP_BIN=${VP_BIN:-$HOME/.vite-plus/bin}
# The REAL Personal Team id of the logged-in Apple ID. Read it from Xcode's
# prefs, NOT from a keychain cert (those can carry DEAD enrollment team ids):
#   defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier
DEV_TEAM=${DEV_TEAM:-C9US239HQB}
DEVICE_NAME=${DEVICE_NAME:-fon}         # `xcrun devicectl list devices` name
WS=${WS:-ios/T3CodePreview.xcworkspace}
SCHEME=${SCHEME:-T3CodePreview}
LOG=${LOG:-$HOME/ios-device-build.log}
# ===========================================================================
set -o pipefail
export PATH="$VP_BIN:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
: > "$LOG"
cd "$REPO/apps/mobile" || exit 1
echo "WS=$WS TEAM=$DEV_TEAM bundle=$(grep -m1 -oE 'PRODUCT_BUNDLE_IDENTIFIER = [^;]+' ios/*.xcodeproj/project.pbxproj)" >> "$LOG"

echo "=== BUILD (device, personal team) ===" >> "$LOG"
rm -rf /tmp/t3code-ios-build
xcodebuild -workspace "$WS" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/t3code-ios-build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$DEV_TEAM" CODE_SIGN_STYLE=Automatic \
  build >> "$LOG" 2>&1
echo "BUILD_EXIT=$?" >> "$LOG"

APP=$(find /tmp/t3code-ios-build/Build/Products/Release-iphoneos -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
echo "APP=$APP" >> "$LOG"
if [ -n "$APP" ]; then
  echo "=== INSTALL to $DEVICE_NAME ===" >> "$LOG"
  xcrun devicectl device install app --device "$DEVICE_NAME" "$APP" >> "$LOG" 2>&1
  echo "INSTALL_EXIT=$?" >> "$LOG"
fi
echo "IOS_DEVICE_BUILD_DONE" >> "$LOG"
# Reminder: a free-team build re-signs every 7 days (rerun this), has no
# widget/push/apple-sign-in, and first run needs
# Settings -> VPN & Device Management -> Trust the developer.
