#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

import { relayPublicDomainForStage } from "../src/deploymentConfig.ts";

export class RelayDeployError extends Data.TaggedError("RelayDeployError")<{
  readonly message: string;
}> {}

export function readEnvFileArgument(args: ReadonlyArray<string>): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--env-file") {
      return args[index + 1];
    }
    if (argument?.startsWith("--env-file=")) {
      return argument.slice("--env-file=".length);
    }
  }
  return undefined;
}

export function readStageArgument(args: ReadonlyArray<string>): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stage") {
      return args[index + 1];
    }
    if (argument?.startsWith("--stage=")) {
      return argument.slice("--stage=".length);
    }
  }
  return undefined;
}

export function resolveRelayDeployDomain(input: {
  readonly relayDomainOverride: Option.Option<string>;
  readonly stage: string;
  readonly zoneName: string;
}): string {
  return Option.getOrElse(input.relayDomainOverride, () =>
    relayPublicDomainForStage(input.stage, input.zoneName),
  );
}

export function reconcileRootEnvRelayUrl(contents: string, relayUrl: string): string {
  const entry = `T3_RELAY_URL=${relayUrl}`;
  if (/^T3_RELAY_URL=.*$/mu.test(contents)) {
    return contents.replace(/^T3_RELAY_URL=.*$/mu, entry);
  }
  if (!contents) {
    return `${entry}\n`;
  }
  return `${contents}${contents.endsWith("\n") ? "" : "\n"}${entry}\n`;
}

export function makeDeployConfigProvider(
  environmentProvider: ConfigProvider.ConfigProvider,
  dotenvProvider?: ConfigProvider.ConfigProvider,
) {
  return dotenvProvider
    ? ConfigProvider.orElse(environmentProvider, dotenvProvider)
    : environmentProvider;
}

const relayRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const repoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const loadDeployConfigProvider = Effect.fn("relay.deploy.loadConfigProvider")(function* (
  args: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* relayRoot;
  const selectedEnvFile = readEnvFileArgument(args);
  const envFile = selectedEnvFile ? path.resolve(root, selectedEnvFile) : path.join(root, ".env");
  if (!(yield* fs.exists(envFile))) {
    return makeDeployConfigProvider(ConfigProvider.fromEnv());
  }
  return makeDeployConfigProvider(
    ConfigProvider.fromEnv(),
    yield* ConfigProvider.fromDotEnv({ path: envFile }),
  );
});

const runAlchemyDeploy = Effect.fn("relay.deploy.runAlchemy")(function* (
  args: ReadonlyArray<string>,
) {
  const root = yield* relayRoot;
  const child = yield* ChildProcess.make("alchemy", ["deploy", ...args], {
    cwd: root,
    detached: false,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new RelayDeployError({
      message: `alchemy deploy exited with code ${exitCode}`,
    });
  }
});

const reconcileRootEnv = Effect.fn("relay.deploy.reconcileRootEnv")(function* (
  args: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const provider = yield* loadDeployConfigProvider(args);
  const config = yield* Config.all({
    relayDomainOverride: Config.nonEmptyString("T3_RELAY_DOMAIN").pipe(Config.option),
    stage: Config.nonEmptyString("stage").pipe(
      Config.option,
      Config.map(
        Option.getOrElse(() => `dev_${process.env.USER ?? process.env.USERNAME ?? "unknown"}`),
      ),
    ),
    zoneName: Config.nonEmptyString("T3_RELAY_ZONE_NAME"),
  }).pipe(Effect.provide(ConfigProvider.layer(provider)));
  const relayDomain = resolveRelayDeployDomain({
    ...config,
    stage: readStageArgument(args) ?? config.stage,
  });
  const relayUrl = `https://${relayDomain}`;
  const rootEnvPath = path.join(root, ".env");
  const contents = (yield* fs.exists(rootEnvPath)) ? yield* fs.readFileString(rootEnvPath) : "";

  yield* fs.writeFileString(rootEnvPath, reconcileRootEnvRelayUrl(contents, relayUrl));
  yield* Console.log(`Updated ${rootEnvPath} with T3_RELAY_URL=${relayUrl}`);
});

export const deploy = Effect.fn("relay.deploy")(function* (args: ReadonlyArray<string>) {
  yield* runAlchemyDeploy(args);
  yield* reconcileRootEnv(args);
});

if (import.meta.main) {
  deploy(process.argv.slice(2)).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
