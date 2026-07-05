import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildProviderInstanceUpdatePatch,
  deriveProviderSettingsSections,
  formatDiagnosticsDescription,
  type ProviderSettingsEnvironmentInput,
} from "./SettingsPanels.logic";

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("deriveProviderSettingsSections", () => {
  const localEnvironment: ProviderSettingsEnvironmentInput = {
    environmentId: EnvironmentId.make("env-local"),
    label: "This device",
    displayUrl: "http://127.0.0.1:4100",
    isPrimary: true,
    connectionPhase: "connected",
  };
  const serverEnvironment: ProviderSettingsEnvironmentInput = {
    environmentId: EnvironmentId.make("env-server"),
    label: "Studio",
    displayUrl: "https://studio.example.com",
    isPrimary: false,
    connectionPhase: "connected",
  };

  it("keeps the plain single-section layout when only the primary environment exists", () => {
    expect(deriveProviderSettingsSections([localEnvironment])).toEqual([
      { environmentId: localEnvironment.environmentId, title: "Providers", isPrimary: true },
    ]);
  });

  it("lists connected servers first and labels the primary as the local app", () => {
    expect(deriveProviderSettingsSections([localEnvironment, serverEnvironment])).toEqual([
      {
        environmentId: serverEnvironment.environmentId,
        title: "Providers — Studio",
        isPrimary: false,
      },
      {
        environmentId: localEnvironment.environmentId,
        title: "Providers — This app (local)",
        isPrimary: true,
      },
    ]);
  });

  it("skips catalog servers that are not connected", () => {
    expect(
      deriveProviderSettingsSections([
        localEnvironment,
        { ...serverEnvironment, connectionPhase: "reconnecting" },
      ]),
    ).toEqual([
      { environmentId: localEnvironment.environmentId, title: "Providers", isPrimary: true },
    ]);
  });

  it("falls back to the display URL, then a generic label, for unnamed servers", () => {
    const sections = deriveProviderSettingsSections([
      localEnvironment,
      { ...serverEnvironment, label: "" },
      {
        ...serverEnvironment,
        environmentId: EnvironmentId.make("env-server-2"),
        label: "",
        displayUrl: null,
      },
    ]);
    expect(sections.map((section) => section.title)).toEqual([
      "Providers — https://studio.example.com",
      "Providers — Server",
      "Providers — This app (local)",
    ]);
  });

  it("renders server sections even when no primary environment is present", () => {
    expect(deriveProviderSettingsSections([serverEnvironment])).toEqual([
      {
        environmentId: serverEnvironment.environmentId,
        title: "Providers — Studio",
        isPrimary: false,
      },
    ]);
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});
