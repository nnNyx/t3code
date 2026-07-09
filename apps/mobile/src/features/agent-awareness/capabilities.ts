import Constants from "expo-constants";

// Personal-team (free Apple ID) builds have push/APNs entitlements stripped at
// build time by plugins/withoutIosPersonalTeamCapabilities.cjs, so push-token
// registration and Live Activities can never succeed. Gate on the flag
// app.config.ts records in `extra` rather than attempting and silently failing.
export function supportsAgentAwarenessPush() {
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}
