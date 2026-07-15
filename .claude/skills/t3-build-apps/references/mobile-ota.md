# Mobile OTA update (no device rebuild)

JS-only mobile changes can ship as an EAS OTA update onto an already-installed
preview build, skipping the whole native rebuild. Native/config changes still
need a device rebuild (references/android.md, references/ios.md).

OTA is self-hosted under the fork's own Expo project (owner: `@eyeveil/t3-code`,
projectId in `apps/mobile/app.config.ts` → `owner` / `extra.eas.projectId` /
`updates.url`). EAS login lives on the Mac as that Expo user (`~/.expo`).
Substitute your own Expo project + login.

## Env for any mobile build/update (Mac)

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)   # default java is too new
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
```

## Local build (Android APK)

```bash
cd apps/mobile
eas build --local --platform android --profile preview --non-interactive \
  --output ~/dev/t3code/release/t3code-preview.apk
```

Four hurdles, all fixed in-repo except signing creds:

- **Signing:** `apps/mobile/credentials.json` + `credentials/<you>-android.jks`
  (both gitignored). Non-interactive local builds read these.
- **expo-doctor gate:** the preview profile sets
  `EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1` (fork's dep divergence is intentional).
- **Fingerprint mismatch:** preview uses `MOBILE_VERSION_POLICY=appVersion`
  (deterministic runtime `0.1.0`). `eas update` must run with the SAME env.
- **Gradle D8 OOM:** fixed by `plugins/withAndroidGradleHeap.cjs` (→ `-Xmx6144m`).
  Note: `eas build --local` builds in a TEMP copy
  (`/private/var/folders/*/T/eas-build-local-nodejs/*/…/android/`), NOT the
  source tree — verify plugin effects by grepping the temp gradle.properties.

## Publish OTA

```bash
cd apps/mobile
APP_VARIANT=preview MOBILE_VERSION_POLICY=appVersion \
  eas update --branch preview --environment preview \
  --message '...' --non-interactive
```

`--environment` is required in non-interactive mode. Runtime must match the
installed build (`0.1.0`) or the update won't resolve onto it.
