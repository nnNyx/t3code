import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: "t3code.test",
  managedEndpointNamespace: "dev_julius",
});

interface TunnelCall {
  readonly operation: "list" | "create" | "putConfiguration" | "getToken";
  readonly input: unknown;
}

interface DnsCall {
  readonly operation: "listCnameRecords" | "createCnameRecord" | "updateCnameRecord";
  readonly input: unknown;
}

function makeTunnelClient(calls: TunnelCall[] = []) {
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: [] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        return { id: "tunnel-id", name: request.name };
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
  });
}

function makeDnsClient(
  calls: DnsCall[] = [],
  records: ReadonlyArray<{ readonly id: string }> = [],
) {
  return ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    listCnameRecords: (hostname) =>
      Effect.sync(() => {
        calls.push({ operation: "listCnameRecords", input: hostname });
        return records;
      }),
    createCnameRecord: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "createCnameRecord", input: request });
      }),
    updateCnameRecord: (dnsRecordId, request) =>
      Effect.sync(() => {
        calls.push({ operation: "updateCnameRecord", input: { dnsRecordId, request } });
      }),
  });
}

function providerLayer(tunnelClient = makeTunnelClient(), dnsClient = makeDnsClient()) {
  return ManagedEndpointProvider.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, config)),
    Layer.provide(Layer.succeed(ManagedEndpointProvider.ManagedEndpointTunnelClient, tunnelClient)),
    Layer.provide(Layer.succeed(ManagedEndpointProvider.ManagedEndpointDnsClient, dnsClient)),
  );
}

function expectedManagedHostname(environmentId: string): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`dev_julius:${environmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `tunnels-dev-julius-${hash}.t3code.test`;
}

function expectedManagedTunnelName(environmentId: string): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(`dev_julius:${environmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `t3coderelay-managedendpoint-dev-julius-${hash}`;
}

describe("ManagedEndpointProvider", () => {
  it.effect("provisions a Cloudflare tunnel endpoint and connector token", () => {
    const tunnelCalls: TunnelCall[] = [];
    const dnsCalls: DnsCall[] = [];

    return Effect.gen(function* () {
      const hostname = expectedManagedHostname("env_ABC");
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(result).toEqual({
        endpoint: {
          httpBaseUrl: `https://${hostname}/`,
          wsBaseUrl: `wss://${hostname}/ws`,
          providerKind: "cloudflare_tunnel",
        },
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-id",
          tunnelName: expectedManagedTunnelName("env_ABC"),
        },
      });
      expect(dnsCalls).toEqual([
        { operation: "listCnameRecords", input: hostname },
        {
          operation: "createCnameRecord",
          input: {
            type: "CNAME",
            name: hostname,
            content: "tunnel-id.cfargotunnel.com",
            ttl: 1,
            proxied: true,
          },
        },
      ]);
      expect(tunnelCalls.map((call) => call.operation)).toEqual([
        "list",
        "create",
        "putConfiguration",
        "getToken",
      ]);
      expect(tunnelCalls[2]?.input).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              hostname,
              service: "http://127.0.0.1:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
      expect(tunnelCalls[0]?.input).toEqual({
        name: expectedManagedTunnelName("env_ABC"),
        isDeleted: false,
      });
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls), makeDnsClient(dnsCalls))));
  });

  it.effect("uses stage-scoped stable names without leaking unusual environment ids", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const environmentId = "ENV With Spaces/../Symbols!" + "x".repeat(80);
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        environmentId,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      const requestedName = (
        tunnelCalls.find((call) => call.operation === "list")?.input as
          | { readonly name?: string }
          | undefined
      )?.name;
      expect(requestedName).toMatch(/^t3coderelay-managedendpoint-dev-julius-[a-f0-9]{16}$/);
      const configBody = (
        tunnelCalls.find((call) => call.operation === "putConfiguration")?.input as
          | { readonly tunnelConfig?: unknown }
          | undefined
      )?.tunnelConfig;
      expect(configBody).toMatchObject({
        ingress: [
          {
            hostname: expect.stringMatching(/^tunnels-dev-julius-[a-f0-9]{16}\.t3code\.test$/),
          },
          { service: "http_status:404" },
        ],
      });
      const hostname = (
        configBody as
          | {
              readonly ingress?: readonly [{ readonly hostname?: unknown }, unknown];
            }
          | undefined
      )?.ingress?.[0]?.hostname;
      expect(typeof hostname === "string" ? hostname.split(".")[0]?.length : 0).toBeLessThanOrEqual(
        63,
      );
      expect(tunnelCalls.find((call) => call.operation === "create")?.input).toMatchObject({
        name: requestedName,
        configSrc: "cloudflare",
      });
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("formats IPv6 loopback origins as valid Cloudflare ingress service URLs", () => {
    const tunnelCalls: TunnelCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        environmentId: "env-ipv6",
        origin: { localHttpHost: "::1", localHttpPort: 3773 },
      });

      expect(
        tunnelCalls.find((call) => call.operation === "putConfiguration")?.input,
      ).toMatchObject({
        tunnelConfig: {
          ingress: [
            {
              service: "http://[::1]:3773",
            },
            { service: "http_status:404" },
          ],
        },
      });
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(tunnelCalls))));
  });

  it.effect("rejects non-loopback managed endpoint origins before calling Cloudflare", () => {
    const dnsCalls: DnsCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "192.168.1.10", localHttpPort: 3773 },
        }),
      );

      expect(dnsCalls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls))));
  });

  it.effect("rejects invalid managed endpoint origin ports before calling Cloudflare", () => {
    const dnsCalls: DnsCall[] = [];

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* Effect.result(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 65_536 },
        }),
      );

      expect(dnsCalls).toHaveLength(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ManagedEndpointOriginNotAllowed");
      }
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls))));
  });

  it.effect("updates an existing CNAME record through the DNS client", () => {
    const dnsCalls: DnsCall[] = [];
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        environmentId: "env_ABC",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      expect(dnsCalls.map((call) => call.operation)).toEqual([
        "listCnameRecords",
        "updateCnameRecord",
      ]);
      expect(dnsCalls[1]?.input).toMatchObject({ dnsRecordId: "existing-record-id" });
    }).pipe(
      Effect.provide(
        providerLayer(makeTunnelClient(), makeDnsClient(dnsCalls, [{ id: "existing-record-id" }])),
      ),
    );
  });

  it.effect("fails provisioning when the DNS client fails", () => {
    const failure = new ManagedEndpointProvider.ManagedEndpointDnsClientError({
      cause: "Cloudflare DNS failure",
    });
    const dnsClient = ManagedEndpointProvider.ManagedEndpointDnsClient.of({
      listCnameRecords: () => Effect.fail(failure),
      createCnameRecord: () => Effect.die("unused"),
      updateCnameRecord: () => Effect.die("unused"),
    });

    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          environmentId: "env_ABC",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );

      expect(error._tag).toBe("ManagedEndpointProvisioningFailed");
      expect(error.cause).toBe(failure);
    }).pipe(Effect.provide(providerLayer(makeTunnelClient(), dnsClient)));
  });
});
