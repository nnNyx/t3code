import type { ExpoConfig } from "expo/config";

// Helpers for building an iOS app a *free Apple Personal Team* can code-sign.
//
// A personal team (no paid Apple Developer Program membership) cannot provision
// any capability that needs an entitlement granted by the program. If the app —
// or any bundled target — requests one, signing fails outright. These helpers
// take the fully-configured Expo app and remove every such capability so the
// build installs on a physical device signed by a personal team. They run ONLY
// when T3CODE_PERSONAL_TEAM is set; the default build never touches them.

type PluginEntry = NonNullable<ExpoConfig["plugins"]>[number];

// Entitlement plist keys that require a paid membership, spelled as they appear
// in a generated *.entitlements file. Deleting them here is a defensive backstop
// for anything set directly on `ios.entitlements`; the bulk of the stripping is
// done by removing the plugins/config that generate them at prebuild time.
const PAID_ENTITLEMENT_KEYS = [
  "aps-environment", // Push Notifications
  "com.apple.developer.applesignin", // Sign in with Apple
  "com.apple.developer.associated-domains", // Associated Domains (applinks/webcredentials)
  "com.apple.security.application-groups", // App Groups (shared container with the widget)
] as const;

// Config plugins removed wholesale for a personal-team build.
const PAID_CAPABILITY_PLUGINS = new Set<string>([
  // The widget / Live Activity extension (ExpoWidgetsTarget) is a *second* app
  // target. It needs an App Group to share data with the app and push for live
  // updates — both paid — so the whole target is dropped.
  "expo-widgets",
  // Decorates the widget target's asset catalog. With the widget stripped the
  // target no longer exists, and this plugin throws when it can't find it
  // (addWidgetAssetCatalog: target "ExpoWidgetsTarget" not found), so it must go
  // too.
  "./plugins/withWidgetLogoAsset.cjs",
]);

/** Reads a plugin entry's name whether it is a bare string or a [name, opts] tuple. */
export function pluginName(plugin: PluginEntry): string | undefined {
  if (typeof plugin === "string") return plugin;
  if (Array.isArray(plugin) && typeof plugin[0] === "string") return plugin[0];
  return undefined;
}

// @clerk/expo's `appleSignIn: true` option makes its config plugin add the
// com.apple.developer.applesignin entitlement. Force the option off — keeping
// every other Clerk option (theme, Google sign-in, …) — rather than dropping the
// plugin outright.
function disableClerkAppleSignIn(plugin: PluginEntry): PluginEntry {
  if (Array.isArray(plugin)) {
    const [name, options] = plugin;
    return [name as string, { ...(options as Record<string, unknown>), appleSignIn: false }];
  }
  return ["@clerk/expo", { appleSignIn: false }];
}

/**
 * Returns a copy of `config` with every paid-only iOS capability removed so a
 * free Apple Personal Team can sign it. Pure: it does not mutate `config`.
 */
export function stripPaidCapabilities(config: ExpoConfig): ExpoConfig {
  const ios: NonNullable<ExpoConfig["ios"]> = { ...config.ios };

  // Associated Domains -> com.apple.developer.associated-domains (paid).
  delete ios.associatedDomains;
  // usesAppleSignIn -> com.apple.developer.applesignin (paid).
  delete ios.usesAppleSignIn;
  // appleTeamId pins signing to the paid T3 Tools team; a personal team must
  // sign with its own team, so leave it unset for Xcode to fill in.
  delete ios.appleTeamId;

  if (ios.entitlements) {
    const entitlements = { ...ios.entitlements };
    for (const key of PAID_ENTITLEMENT_KEYS) delete entitlements[key];
    ios.entitlements = entitlements;
  }

  const plugins = (config.plugins ?? [])
    .filter((plugin) => {
      const name = pluginName(plugin);
      return name === undefined || !PAID_CAPABILITY_PLUGINS.has(name);
    })
    .map((plugin) =>
      pluginName(plugin) === "@clerk/expo" ? disableClerkAppleSignIn(plugin) : plugin,
    );

  return {
    ...config,
    ios,
    // Backstop: delete the paid entitlement keys from the generated main-app
    // *.entitlements after every other plugin has run, in case a dependency
    // (e.g. expo-notifications) re-adds one. Registered last so its deletes win.
    plugins: [...plugins, "./plugins/withoutIosPersonalTeamCapabilities.cjs"],
  };
}

/** Truthy-string check for the T3CODE_PERSONAL_TEAM flag (1/true/yes/on, etc.). */
export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== "" &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "no" &&
    normalized !== "off"
  );
}
