import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { relayPublicDomainForStage } from "./deploymentConfig.ts";

export const RelayDeploymentConfig = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  const managedEndpointZoneName = yield* Config.nonEmptyString("T3_RELAY_ZONE_NAME");
  const relayPublicDomainOverride = yield* Config.nonEmptyString("T3_RELAY_DOMAIN").pipe(
    Config.option,
  );
  const relayPublicDomain = Option.getOrElse(relayPublicDomainOverride, () =>
    relayPublicDomainForStage(stage, managedEndpointZoneName),
  );

  return {
    stage,
    relayPublicDomain,
    relayPublicOrigin: `https://${relayPublicDomain}`,
    managedEndpointZoneName,
  };
});

export const ManagedEndpointZone = RelayDeploymentConfig.pipe(
  Effect.map(({ managedEndpointZoneName }) => managedEndpointZoneName),
  Effect.flatMap((name) => Cloudflare.Zone("ManagedEndpointZone", { name }).pipe(adopt(true))),
);
