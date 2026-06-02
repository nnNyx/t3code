import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  makeDeployConfigProvider,
  readEnvFileArgument,
  readStageArgument,
  reconcileRootEnvRelayUrl,
  resolveRelayDeployDomain,
} from "./deploy.ts";

describe("readEnvFileArgument", () => {
  it("supports separated and inline Alchemy env file flags", () => {
    expect(readEnvFileArgument(["--stage", "preview", "--env-file", ".env.preview"])).toBe(
      ".env.preview",
    );
    expect(readEnvFileArgument(["--env-file=.env.preview"])).toBe(".env.preview");
  });
});

describe("readStageArgument", () => {
  it("supports separated and inline Alchemy stage flags", () => {
    expect(readStageArgument(["--stage", "dev_julius"])).toBe("dev_julius");
    expect(readStageArgument(["--stage=dev_julius"])).toBe("dev_julius");
  });
});

describe("resolveRelayDeployDomain", () => {
  it("derives personal stage domains from the imported Cloudflare zone", () => {
    expect(
      resolveRelayDeployDomain({
        relayDomainOverride: Option.none(),
        stage: "dev_julius",
        zoneName: "example.test",
      }),
    ).toBe("relay-dev-julius.example.test");
  });

  it("preserves explicit domain overrides", () => {
    expect(
      resolveRelayDeployDomain({
        relayDomainOverride: Option.some("relay.override.test"),
        stage: "dev_julius",
        zoneName: "example.test",
      }),
    ).toBe("relay.override.test");
  });
});

describe("makeDeployConfigProvider", () => {
  it("prefers injected environment values while retaining dotenv fallbacks", async () => {
    const provider = makeDeployConfigProvider(
      ConfigProvider.fromEnv({ env: { T3_RELAY_DOMAIN: "ci.example.test" } }),
      ConfigProvider.fromEnv({
        env: {
          T3_RELAY_DOMAIN: "dotenv.example.test",
          T3_RELAY_ZONE_NAME: "example.test",
        },
      }),
    );
    const config = Config.all({
      relayDomain: Config.string("T3_RELAY_DOMAIN"),
      relayZoneName: Config.string("T3_RELAY_ZONE_NAME"),
    }).pipe(Effect.provide(ConfigProvider.layer(provider)));

    await expect(Effect.runPromise(config)).resolves.toEqual({
      relayDomain: "ci.example.test",
      relayZoneName: "example.test",
    });
  });
});

describe("reconcileRootEnvRelayUrl", () => {
  it("adds the relay URL to an empty root env file", () => {
    expect(reconcileRootEnvRelayUrl("", "https://relay.example.test")).toBe(
      "T3_RELAY_URL=https://relay.example.test\n",
    );
  });

  it("preserves unrelated root env entries while replacing a previous relay URL", () => {
    expect(
      reconcileRootEnvRelayUrl(
        "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3_RELAY_URL=https://old.example.test\n",
        "https://relay.example.test",
      ),
    ).toBe(
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3_RELAY_URL=https://relay.example.test\n",
    );
  });
});
