import type { ExpoConfig } from "expo/config";
import { describe, expect, it } from "@effect/vitest";

import { isTruthy, pluginName, stripPaidCapabilities } from "./personalTeam.ts";

function baseConfig(): ExpoConfig {
  return {
    name: "T3 Code Preview",
    slug: "t3-code",
    ios: {
      bundleIdentifier: "com.t3tools.t3code.preview",
      appleTeamId: "ARK85ZXQ4Z",
      usesAppleSignIn: true,
      associatedDomains: ["applinks:clerk.t3.codes", "webcredentials:clerk.t3.codes"],
      entitlements: {
        "aps-environment": "production",
        "com.apple.developer.applesignin": ["Default"],
        "com.apple.developer.associated-domains": ["applinks:clerk.t3.codes"],
        "com.apple.security.application-groups": ["group.com.t3tools.t3code.preview"],
        "keep.me": true,
      },
    },
    plugins: [
      "expo-secure-store",
      ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: true }],
      "./plugins/withWidgetLogoAsset.cjs",
      ["expo-widgets", { groupIdentifier: "group.com.t3tools.t3code.preview" }],
      "./plugins/withIosSceneLifecycle.cjs",
    ],
  };
}

describe("stripPaidCapabilities", () => {
  const stripped = stripPaidCapabilities(baseConfig());
  const pluginNames = (stripped.plugins ?? []).map(pluginName);

  it("removes the widget extension and its asset plugin", () => {
    expect(pluginNames).not.toContain("expo-widgets");
    expect(pluginNames).not.toContain("./plugins/withWidgetLogoAsset.cjs");
  });

  it("keeps unrelated plugins", () => {
    expect(pluginNames).toContain("expo-secure-store");
    expect(pluginNames).toContain("./plugins/withIosSceneLifecycle.cjs");
    expect(pluginNames).toContain("@clerk/expo");
  });

  it("appends the entitlement-cleanup plugin last", () => {
    expect(pluginNames.at(-1)).toBe("./plugins/withoutIosPersonalTeamCapabilities.cjs");
  });

  it("disables Sign in with Apple in @clerk/expo without dropping other options", () => {
    const clerk = (stripped.plugins ?? []).find((p) => pluginName(p) === "@clerk/expo");
    expect(clerk).toEqual(["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: false }]);
  });

  it("drops paid ios capability fields", () => {
    expect(stripped.ios?.appleTeamId).toBeUndefined();
    expect(stripped.ios?.associatedDomains).toBeUndefined();
    expect(stripped.ios?.usesAppleSignIn).toBeUndefined();
  });

  it("keeps the bundle id intact", () => {
    expect(stripped.ios?.bundleIdentifier).toBe("com.t3tools.t3code.preview");
  });

  it("deletes paid entitlement plist keys but keeps others", () => {
    expect(stripped.ios?.entitlements).toEqual({ "keep.me": true });
  });

  it("does not mutate the input", () => {
    const input = baseConfig();
    stripPaidCapabilities(input);
    expect(input.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
    expect((input.plugins ?? []).map(pluginName)).toContain("expo-widgets");
  });
});

describe("isTruthy", () => {
  it("treats 1/true/yes/on and other non-empty strings as truthy", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", "anything"]) {
      expect(isTruthy(value)).toBe(true);
    }
  });

  it("treats undefined and falsy strings as false", () => {
    for (const value of [undefined, "", " ", "0", "false", "no", "off", "OFF"]) {
      expect(isTruthy(value)).toBe(false);
    }
  });
});
