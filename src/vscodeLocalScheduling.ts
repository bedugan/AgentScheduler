import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MacOsLaunchdWakeupProvider,
  WindowsTaskSchedulerWakeupProvider,
  type WakeupProvider,
  type WakeupTriggerRequest,
} from "./localSchedulingSetup.js";

export const SQLITE_LOCAL_STORE_FILENAME = "agent-scheduler.sqlite";

export interface VsCodeGlobalStorageContextLike {
  globalStorageUri: { fsPath: string };
}
export interface VsCodeInstalledExtensionContextLike
  extends VsCodeGlobalStorageContextLike {
  extensionUri: { fsPath: string };
}

export function sqliteLocalStorePath(
  context: VsCodeGlobalStorageContextLike,
): string {
  return join(context.globalStorageUri.fsPath, SQLITE_LOCAL_STORE_FILENAME);
}

export interface ResolveNodeRuntimeExecutableOptions {
  configuredPath?: string;
  processExecutable?: string;
  searchPath?: string;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  probeRuntime?: (path: string) => boolean;
  workerPath?: string;
  workerPlatform?: "windows" | "macos";
  userId?: number;
}

export function resolveNodeRuntimeExecutable(
  options: ResolveNodeRuntimeExecutableOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const probeRuntime =
    options.probeRuntime ??
    ((candidate: string) => probeNodeRuntime(candidate, options));
  const pathApi = platform === "win32" ? win32 : posix;
  const candidates = [
    options.configuredPath,
    options.processExecutable ?? process.execPath,
    ...(options.searchPath ?? process.env.PATH ?? "")
      .split(platform === "win32" ? ";" : ":")
      .filter(Boolean)
      .map((directory) =>
        pathApi.join(directory, platform === "win32" ? "node.exe" : "node"),
      ),
  ];

  for (const candidate of candidates) {
    if (!candidate || !pathApi.isAbsolute(candidate) || !fileExists(candidate)) {
      continue;
    }
    const executableName = pathApi.basename(candidate).toLowerCase();
    if (
      (executableName === "node" || executableName === "node.exe") &&
      probeRuntime(candidate)
    ) {
      return candidate;
    }
  }

  throw new Error(
    "Local Scheduling requires an absolute Node.js executable. Configure AGENT_SCHEDULER_NODE_PATH or install node on PATH; the VS Code Electron executable cannot run the worker.",
  );
}

function probeNodeRuntime(
  candidate: string,
  options: ResolveNodeRuntimeExecutableOptions,
): boolean {
  const capabilityProbe = spawnSync(
    candidate,
    [
      "-e",
      "const major=Number(process.versions.node.split('.')[0]);require('node:sqlite');if(major<26)process.exit(1)",
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (capabilityProbe.status !== 0 || !options.workerPath) {
    return capabilityProbe.status === 0 && options.workerPath === undefined;
  }

  const platform = options.workerPlatform ?? "windows";
  const args = [
    options.workerPath,
    "local-scheduling",
    "install",
    "--dry-run",
    "--platform",
    platform,
    "--store",
    join(dirname(options.workerPath), "probe.sqlite"),
    "--node",
    candidate,
    "--worker",
    options.workerPath,
  ];
  if (platform === "macos") {
    args.push("--user-id", String(options.userId ?? 0));
  }
  const workerModuleUrl = pathToFileURL(options.workerPath).href;
  const probeScript = `import { runWorkerCli } from ${JSON.stringify(workerModuleUrl)}; process.exitCode = await runWorkerCli(${JSON.stringify(args.slice(1))}, { stdout: process.stdout, stderr: process.stderr });`;
  const workerProbe = spawnSync(candidate, ["--input-type=module", "-e", probeScript], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return workerProbe.status === 0 && /"dryRun":true/.test(workerProbe.stdout);
}

export interface DeployedWorker {
  workerPath: string;
  fingerprint: string;
}

export function deployPackagedWorker(
  context: VsCodeInstalledExtensionContextLike,
): DeployedWorker {
  const sourceDirectory = join(context.extensionUri.fsPath, "dist", "src");
  const manifest = workerManifestFor(sourceDirectory);
  const fingerprint = manifest.fingerprint;
  const targetDirectory = join(
    context.globalStorageUri.fsPath,
    "worker",
    fingerprint,
  );
  if (!validWorkerDeployment(targetDirectory, manifest)) {
    mkdirSync(dirname(targetDirectory), { recursive: true, mode: 0o700 });
    const claimDirectory = `${targetDirectory}.claim`;
    const ownsClaim = acquireWorkerDeploymentClaim(
      claimDirectory,
      targetDirectory,
      manifest,
    );
    if (ownsClaim) {
      try {
        if (!validWorkerDeployment(targetDirectory, manifest)) {
          installWorkerDeployment(targetDirectory, sourceDirectory, manifest);
        }
      } finally {
        rmSync(claimDirectory, { recursive: true, force: true });
      }
    }
  }
  if (!validWorkerDeployment(targetDirectory, manifest)) {
    throw new Error("Worker deployment did not converge on a valid manifest.");
  }
  return {
    workerPath: join(targetDirectory, "workerCli.js"),
    fingerprint,
  };
}

function installWorkerDeployment(
  targetDirectory: string,
  sourceDirectory: string,
  manifest: WorkerDeploymentManifest,
): void {
  const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`;
  const temporaryDirectory = `${targetDirectory}.tmp.${suffix}`;
  const corruptDirectory = `${targetDirectory}.corrupt.${suffix}`;
  let movedCorruptDeployment = false;
  try {
    mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
    cpSync(sourceDirectory, temporaryDirectory, { recursive: true });
    writeFileSync(
      join(temporaryDirectory, "deployment.json"),
      `${JSON.stringify(manifest)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (!validWorkerDeployment(temporaryDirectory, manifest)) {
      throw new Error("Deployed Worker failed manifest verification.");
    }
    if (existsSync(targetDirectory)) {
      renameSync(targetDirectory, corruptDirectory);
      movedCorruptDeployment = true;
    }
    renameSync(temporaryDirectory, targetDirectory);
    rmSync(corruptDirectory, { recursive: true, force: true });
    movedCorruptDeployment = false;
  } catch (error) {
    if (movedCorruptDeployment && !existsSync(targetDirectory)) {
      renameSync(corruptDirectory, targetDirectory);
    }
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    rmSync(corruptDirectory, { recursive: true, force: true });
  }
}

function acquireWorkerDeploymentClaim(
  claimDirectory: string,
  targetDirectory: string,
  manifest: WorkerDeploymentManifest,
): boolean {
  const deadline = Date.now() + 10_000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      mkdirSync(claimDirectory, { mode: 0o700 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (validWorkerDeployment(targetDirectory, manifest)) {
      return false;
    }
    try {
      if (Date.now() - statSync(claimDirectory).mtimeMs > 30_000) {
        const staleClaim = [
          claimDirectory,
          "stale",
          String(process.pid),
          randomBytes(4).toString("hex"),
        ].join(".");
        renameSync(claimDirectory, staleClaim);
        rmSync(staleClaim, { recursive: true, force: true });
        continue;
      }
    } catch {
      // The owner may have completed between the existence check and cleanup.
    }
    Atomics.wait(waiter, 0, 0, 20);
  }
  if (validWorkerDeployment(targetDirectory, manifest)) {
    return false;
  }
  throw new Error("Timed out waiting for another Worker deployment process.");
}

interface WorkerDeploymentManifest {
  fingerprint: string;
  files: Record<string, string>;
}

function workerManifestFor(directory: string): WorkerDeploymentManifest {
  const files: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        visit(path);
      } else if (name !== "deployment.json") {
        const relativePath = path.slice(directory.length + 1).replaceAll("\\", "/");
        files[relativePath] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  visit(directory);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return { fingerprint, files };
}

function validWorkerDeployment(
  directory: string,
  expected: WorkerDeploymentManifest,
): boolean {
  try {
    const recorded = JSON.parse(
      readFileSync(join(directory, "deployment.json"), "utf8"),
    ) as WorkerDeploymentManifest;
    const actual = workerManifestFor(directory);
    return (
      recorded.fingerprint === expected.fingerprint &&
      JSON.stringify(recorded.files) === JSON.stringify(expected.files) &&
      actual.fingerprint === expected.fingerprint &&
      JSON.stringify(actual.files) === JSON.stringify(expected.files)
    );
  } catch {
    return false;
  }
}

export function localSchedulingWakeupRequestForVsCode(
  context: VsCodeInstalledExtensionContextLike,
  options: {
    nodeExecutable: string;
    platform: NodeJS.Platform;
    userId?: number;
    homeDirectory?: string;
    workerPath?: string;
  },
): WakeupTriggerRequest {
  const triggerId =
    options.platform === "darwin"
      ? "com.bedugan.AgentScheduler.local-wakeup"
      : "AgentSchedulerLocalWakeup";
  const workerPath =
    options.workerPath ??
    join(context.extensionUri.fsPath, "dist", "src", "workerCli.js");
  const request: WakeupTriggerRequest = {
    triggerId,
    workerExecutable: options.nodeExecutable,
    workerArguments: [
      workerPath,
      "scan-due-work",
      "--store",
      sqliteLocalStorePath(context),
    ],
    intervalMinutes: 5,
  };
  if (options.platform === "darwin") {
    request.launchdPlistPath = join(
      options.homeDirectory ?? homedir(),
      "Library",
      "LaunchAgents",
      `${triggerId}.plist`,
    );
    if (options.userId === undefined) {
      throw new Error("Local Scheduling requires a macOS user id for launchd.");
    }
    request.userId = options.userId;
  }
  return request;
}

export interface PrepareVsCodeLocalSchedulingOptions {
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  userId?: number;
  provider?: WakeupProvider;
  homeDirectory?: string;
  runtimeProbe?: (path: string) => boolean;
}

export type PreparedVsCodeLocalScheduling =
  | {
      available: true;
      provider: WakeupProvider;
      request: WakeupTriggerRequest;
    }
  | {
      available: false;
      reason: string;
      management?: {
        provider: WakeupProvider;
        request: WakeupTriggerRequest;
      };
    };

export function prepareVsCodeLocalScheduling(
  context: VsCodeInstalledExtensionContextLike,
  options: PrepareVsCodeLocalSchedulingOptions = {},
): PreparedVsCodeLocalScheduling {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    return {
      available: false,
      reason: `Local Scheduling is not supported on ${platform}. Schedule editing and Manual Run Now remain available.`,
    };
  }
  const deployedWorker = deployPackagedWorker(context);
  const provider =
    options.provider ??
    (platform === "win32"
      ? new WindowsTaskSchedulerWakeupProvider()
      : new MacOsLaunchdWakeupProvider());
  const userId =
    platform === "darwin" ? options.userId ?? process.getuid?.() : undefined;
  const configuredNodeExecutable =
    options.nodeExecutable ?? process.env.AGENT_SCHEDULER_NODE_PATH;
  const requestFor = (nodeExecutable: string) =>
    localSchedulingWakeupRequestForVsCode(context, {
      nodeExecutable,
      platform,
      ...(userId !== undefined && { userId }),
      ...(options.homeDirectory && { homeDirectory: options.homeDirectory }),
      workerPath: deployedWorker.workerPath,
    });
  try {
    const nodeExecutable = resolveNodeRuntimeExecutable({
      ...(configuredNodeExecutable && { configuredPath: configuredNodeExecutable }),
      processExecutable: process.execPath,
      ...(process.env.PATH && { searchPath: process.env.PATH }),
      platform,
      ...(options.runtimeProbe && { probeRuntime: options.runtimeProbe }),
      workerPath: deployedWorker.workerPath,
      workerPlatform: platform === "win32" ? "windows" : "macos",
      ...(options.userId !== undefined && { userId: options.userId }),
    });
    return { available: true, provider, request: requestFor(nodeExecutable) };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Local Scheduling is unavailable.";
    return {
      available: false,
      reason: `${reason} Schedule editing and Manual Run Now remain available.`,
      management: {
        provider,
        request: requestFor(configuredNodeExecutable ?? process.execPath),
      },
    };
  }
}
