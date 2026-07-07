#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DueWorkScanResult } from "./domain.js";
import {
  LocalSchedulingSetup,
  MacOsLaunchdWakeupProvider,
  WindowsTaskSchedulerWakeupProvider,
  type LocalSchedulingSetupResult,
  type WakeupProvider,
  type WakeupProviderPlatform,
  type WakeupTriggerOperation,
  type WakeupTriggerRequest,
} from "./localSchedulingSetup.js";
import { ScheduleLifecycle, SystemClock } from "./scheduleLifecycle.js";
import { SqliteScheduleStore } from "./sqliteScheduleStore.js";

export interface WorkerCliLocalSchedulingSetup {
  install(): Promise<LocalSchedulingSetupResult>;
  verify(): Promise<LocalSchedulingSetupResult>;
  uninstall(): Promise<LocalSchedulingSetupResult>;
}

export interface WorkerCliLifecycle {
  scanDueWork(): Promise<DueWorkScanResult>;
}

export interface WorkerCliDependencies {
  localSchedulingSetup?: WorkerCliLocalSchedulingSetup;
  lifecycle?: WorkerCliLifecycle;
}

export interface WorkerCliIo {
  stdout?: WorkerCliOutput;
  stderr?: WorkerCliOutput;
}

type WorkerCliOutput = string[] | { write(chunk: string): unknown };

interface LocalSchedulingCliOptions {
  dryRun: boolean;
  platform: WakeupProviderPlatform;
  storePath: string | undefined;
  nodePath: string;
  workerPath: string;
  triggerId: string;
  intervalMinutes: number;
  launchdPlistPath: string | undefined;
  userId: number | undefined;
}

export async function runWorkerCli(
  argv: readonly string[],
  io: WorkerCliIo = {},
  dependencies: WorkerCliDependencies = {},
): Promise<number> {
  const [command, subcommand] = argv;

  try {
    if (command === "local-scheduling") {
      return runLocalSchedulingCommand(
        subcommand,
        argv.slice(2),
        io,
        dependencies,
      );
    }

    if (command === "scan-due-work") {
      return runScanDueWorkCommand(argv.slice(1), io, dependencies);
    }

    writeLine(io.stderr, "Unknown worker CLI command.");
    return 1;
  } catch (error) {
    writeLine(
      io.stderr,
      error instanceof Error ? error.message : "Worker CLI command failed.",
    );
    return 1;
  }
}

async function runLocalSchedulingCommand(
  subcommand: string | undefined,
  args: readonly string[],
  io: WorkerCliIo,
  dependencies: WorkerCliDependencies,
): Promise<number> {
  if (!isWakeupTriggerOperation(subcommand)) {
    writeLine(
      io.stderr,
      "Usage: local-scheduling <install|verify|uninstall>",
    );
    return 1;
  }

  const built = dependencies.localSchedulingSetup
    ? { setup: dependencies.localSchedulingSetup, close: undefined }
    : buildLocalSchedulingSetup(subcommand, args, io);
  if ("exitCode" in built) {
    return built.exitCode;
  }

  const setup = built.setup;
  let result: LocalSchedulingSetupResult;
  try {
    switch (subcommand) {
      case "install":
        result = await setup.install();
        break;
      case "verify":
        result = await setup.verify();
        break;
      case "uninstall":
        result = await setup.uninstall();
        break;
    }
  } finally {
    built.close?.();
  }

  writeLocalSchedulingResult(io, result);
  return 0;
}

function buildLocalSchedulingSetup(
  operation: WakeupTriggerOperation,
  args: readonly string[],
  io: WorkerCliIo,
):
  | { setup: WorkerCliLocalSchedulingSetup; close: (() => void) | undefined }
  | { exitCode: number } {
  const options = parseLocalSchedulingOptions(args);
  const provider = wakeupProviderFor(options.platform);
  const request = wakeupTriggerRequestFor(options);

  if (options.dryRun) {
    const intent = provider.intentFor(operation, request);
    writeLine(
      io.stdout,
      JSON.stringify({
        operation: intent.operation,
        platform: intent.platform,
        triggerId: intent.triggerId,
        enabled: false,
        dryRun: true,
        commands: intent.commands,
        files: intent.files,
      }),
    );
    return { exitCode: 0 };
  }

  if (!options.storePath) {
    writeLine(io.stderr, "--store is required for local scheduling setup.");
    return { exitCode: 1 };
  }

  const store = new SqliteScheduleStore({ databasePath: options.storePath });
  return {
    setup: new LocalSchedulingSetup({
      clock: new SystemClock(),
      provider,
      request,
      store,
    }),
    close: () => store.close(),
  };
}

function writeLocalSchedulingResult(
  io: WorkerCliIo,
  result: LocalSchedulingSetupResult,
): void {
  writeLine(
    io.stdout,
    JSON.stringify({
      operation: result.intent.operation,
      platform: result.intent.platform,
      triggerId: result.intent.triggerId,
      enabled: result.state.enabled,
      commands: result.intent.commands,
      files: result.intent.files,
    }),
  );
}

function isWakeupTriggerOperation(
  value: string | undefined,
): value is WakeupTriggerOperation {
  return value === "install" || value === "verify" || value === "uninstall";
}

function parseLocalSchedulingOptions(
  args: readonly string[],
): LocalSchedulingCliOptions {
  const storePath = optionValue(args, "--store");
  const platform = platformFromOption(optionValue(args, "--platform"));
  const triggerId =
    optionValue(args, "--trigger-id") ?? defaultTriggerIdFor(platform);
  const workerPath =
    optionValue(args, "--worker") ?? fileURLToPath(import.meta.url);
  const nodePath = optionValue(args, "--node") ?? process.execPath;
  const intervalMinutes = Number(optionValue(args, "--interval-minutes") ?? "5");
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new Error("--interval-minutes must be a positive integer.");
  }

  return {
    dryRun: args.includes("--dry-run"),
    platform,
    storePath,
    nodePath,
    workerPath,
    triggerId,
    intervalMinutes,
    launchdPlistPath:
      optionValue(args, "--launchd-plist") ??
      (platform === "macos"
        ? join(homedir(), "Library", "LaunchAgents", `${triggerId}.plist`)
        : undefined),
    userId:
      optionValue(args, "--user-id") === undefined
        ? defaultUserId()
        : Number(optionValue(args, "--user-id")),
  };
}

function wakeupTriggerRequestFor(
  options: LocalSchedulingCliOptions,
): WakeupTriggerRequest {
  const workerArguments = [options.workerPath, "scan-due-work"];
  if (options.storePath) {
    workerArguments.push("--store", options.storePath);
  }

  const request: WakeupTriggerRequest = {
    triggerId: options.triggerId,
    workerExecutable: options.nodePath,
    workerArguments,
    intervalMinutes: options.intervalMinutes,
  };

  if (options.platform === "macos") {
    if (options.launchdPlistPath !== undefined) {
      request.launchdPlistPath = options.launchdPlistPath;
    }
    if (options.userId !== undefined) {
      request.userId = options.userId;
    }
  }

  return request;
}

function wakeupProviderFor(platform: WakeupProviderPlatform): WakeupProvider {
  switch (platform) {
    case "windows":
      return new WindowsTaskSchedulerWakeupProvider();
    case "macos":
      return new MacOsLaunchdWakeupProvider();
  }
}

function platformFromOption(
  value: string | undefined,
): WakeupProviderPlatform {
  if (value === "windows" || value === "win32") {
    return "windows";
  }
  if (value === "macos" || value === "darwin") {
    return "macos";
  }
  if (value !== undefined && value.length > 0) {
    throw new Error(`Unsupported local scheduling platform '${value}'.`);
  }

  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "macos";
  }

  throw new Error("Linux wakeup providers are not part of the MVP path.");
}

function defaultTriggerIdFor(platform: WakeupProviderPlatform): string {
  switch (platform) {
    case "windows":
      return "AgentSchedulerLocalWakeup";
    case "macos":
      return "com.bedugan.AgentScheduler.local-wakeup";
  }
}

function defaultUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }

  return args[index + 1];
}

async function runScanDueWorkCommand(
  args: readonly string[],
  io: WorkerCliIo,
  dependencies: WorkerCliDependencies,
): Promise<number> {
  if (dependencies.lifecycle) {
    const result = await dependencies.lifecycle.scanDueWork();
    writeLine(io.stdout, JSON.stringify(result));
    return 0;
  }

  const storePath = optionValue(args, "--store");
  if (!storePath) {
    throw new Error("Schedule lifecycle is not configured.");
  }

  const store = new SqliteScheduleStore({ databasePath: storePath });
  try {
    const lifecycle = new ScheduleLifecycle({
      store,
      harnesses: [],
      localSchedulingSetup: {
        isLocalSchedulingEnabled: async () =>
          (await store.getLocalSchedulingSetup()).enabled,
        getLocalSchedulingSetupState: async () =>
          store.getLocalSchedulingSetup(),
      },
    });
    const result = await lifecycle.scanDueWork();
    writeLine(io.stdout, JSON.stringify(result));
    return 0;
  } finally {
    store.close();
  }
}

function writeLine(output: WorkerCliOutput | undefined, line: string): void {
  if (!output) {
    return;
  }

  if (Array.isArray(output)) {
    output.push(line);
    return;
  }

  output.write(`${line}\n`);
}

function isDirectWorkerCli(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint
    ? import.meta.url === pathToFileURL(entrypoint).href
    : false;
}

if (isDirectWorkerCli()) {
  const exitCode = await runWorkerCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exitCode = exitCode;
}
