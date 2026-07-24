import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel, ServerProviderUsageWindow } from "@t3tools/contracts";

import { derivePrimaryUsageWindows, deriveProviderModelsForDisplay } from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("derivePrimaryUsageWindows", () => {
  const usage: ReadonlyArray<ServerProviderUsageWindow> = [
    { id: "seven_day", label: "Weekly", usedPercent: 28 },
    { id: "five_hour", label: "5h", usedPercent: 64 },
    { id: "other", label: "Other", usedPercent: 99 },
  ];

  it("keeps Codex's 5h and 7d windows in a stable display order", () => {
    expect(derivePrimaryUsageWindows("codex", usage)).toEqual([
      { id: "five_hour", label: "5h", window: usage[1] },
      { id: "seven_day", label: "7d", window: usage[0] },
    ]);
  });

  it("keeps both rows visible when telemetry has not arrived", () => {
    expect(derivePrimaryUsageWindows("codex", undefined)).toEqual([
      { id: "five_hour", label: "5h", window: undefined },
      { id: "seven_day", label: "7d", window: undefined },
    ]);
  });

  it("leaves 5h unavailable when Codex reports only a weekly window", () => {
    const weeklyOnly: ReadonlyArray<ServerProviderUsageWindow> = [
      { id: "seven_day", label: "Weekly", usedPercent: 30 },
    ];

    expect(derivePrimaryUsageWindows("codex", weeklyOnly)).toEqual([
      { id: "five_hour", label: "5h", window: undefined },
      { id: "seven_day", label: "7d", window: weeklyOnly[0] },
    ]);
  });

  it("does not invent usage rows for unsupported drivers", () => {
    expect(derivePrimaryUsageWindows("cursor", usage)).toEqual([]);
  });
});
