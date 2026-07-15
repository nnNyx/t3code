#!/usr/bin/env bash
# Build the t3code preview Android APK and install it on a connected device,
# reusing a STABLE debug keystore so updates install IN PLACE (keeping app data).
#
# Why a stable keystore: the release APK signs with the debug keystore, which is
# gitignored and REGENERATED (new random key) by every `expo prebuild --clean`.
# A new key -> INSTALL_FAILED_UPDATE_INCOMPATIBLE -> you must uninstall, wiping
# app data. So we keep one persistent keystore outside the repo and copy it back
# in after each prebuild. First run adopts whatever prebuild generated.
#
# Why vp's node leads PATH: the system/nix node SIGABRTs (exit 134) inside Metro
# bundling on the owner's Mac. vp's node (`~/.vite-plus/bin`) must come first.
#
# ============================ VARIABLES ====================================
# Owner (Mac) defaults shown — substitute for your machine.
REPO=${REPO:-$HOME/dev/t3code}
STABLE_KEYSTORE=${STABLE_KEYSTORE:-$HOME/.config/t3code-android/debug.keystore}
VP_BIN=${VP_BIN:-$HOME/.vite-plus/bin}
ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
# Java 21: newer JDKs (26) break the gradle template. macOS: java_home -v 21.
JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null)}
DEVICE_MATCH=${DEVICE_MATCH:-model:Pixel_7}   # substring `adb devices -l` must show
# ===========================================================================
set -e
export PATH="$VP_BIN:$ANDROID_HOME/platform-tools:$PATH"
export ANDROID_HOME JAVA_HOME
export NODE_OPTIONS=--max-old-space-size=8192

cd "$REPO/apps/mobile"
APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 CI=1 node_modules/.bin/expo prebuild --clean --platform android

# Restore the persistent key over the freshly-generated throwaway one.
if [ -f "$STABLE_KEYSTORE" ]; then
  cp "$STABLE_KEYSTORE" "$REPO/apps/mobile/android/app/debug.keystore"
else
  mkdir -p "$(dirname "$STABLE_KEYSTORE")"
  cp "$REPO/apps/mobile/android/app/debug.keystore" "$STABLE_KEYSTORE"
  echo "Adopted a new stable keystore at $STABLE_KEYSTORE"
fi

cd "$REPO/apps/mobile/android"
./gradlew --stop >/dev/null 2>&1 || true   # kill stale daemons first
./gradlew assembleRelease "-Dorg.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1536m"

APK="$REPO/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
if adb devices -l | grep -q "$DEVICE_MATCH"; then
  adb install -r "$APK" && echo "DEVICE_UPDATED (in place, data kept)"
else
  echo "APK_READY_NO_DEVICE: $APK (plug in the device, then: adb install -r <apk>)"
fi
