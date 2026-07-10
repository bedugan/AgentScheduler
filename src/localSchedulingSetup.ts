import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { IsoTimestamp } from "./domain.js";
import type { Clock } from "./scheduleLifecycle.js";

export type WakeupProviderPlatform = "windows" | "macos";

export type WakeupTriggerOperation = "install" | "verify" | "uninstall";

export interface WakeupTriggerCommand {
  executable: string;
  args: string[];
  shellCommand: string;
}

export interface WakeupTriggerFile {
  path: string;
  contents: string;
}

export interface WakeupTriggerIntent {
  operation: WakeupTriggerOperation;
  platform: WakeupProviderPlatform;
  triggerId: string;
  intervalMinutes: number;
  workerCommand: string;
  commands: WakeupTriggerCommand[];
  files: WakeupTriggerFile[];
}

export interface WakeupTriggerRequest {
  triggerId: string;
  workerExecutable: string;
  workerArguments: string[];
  intervalMinutes: number;
  launchdPlistPath?: string;
  userId?: number;
}

export interface WakeupTriggerResult {
  intent: WakeupTriggerIntent;
  applied: boolean;
}

export interface WakeupCommandRunner {
  run(command: WakeupTriggerCommand): Promise<WakeupCommandResult | void>;
}

export interface WakeupCommandResult {
  stdout: string;
  stderr: string;
}

export interface WakeupFileWriter {
  write(file: WakeupTriggerFile): Promise<void>;
}

export interface WakeupFileReader {
  read(path: string): Promise<string>;
}

export interface WakeupProviderOptions {
  commandRunner?: WakeupCommandRunner;
  fileWriter?: WakeupFileWriter;
  fileReader?: WakeupFileReader;
}

export interface WakeupProvider {
  readonly platform: WakeupProviderPlatform;
  intentFor(
    operation: WakeupTriggerOperation,
    request: WakeupTriggerRequest,
  ): WakeupTriggerIntent;
  install(request: WakeupTriggerRequest): Promise<WakeupTriggerResult>;
  verify(request: WakeupTriggerRequest): Promise<WakeupTriggerResult>;
  uninstall(request: WakeupTriggerRequest): Promise<WakeupTriggerResult>;
}

export interface LocalSchedulingSetupState {
  enabled: boolean;
  platform: WakeupProviderPlatform | null;
  triggerId: string | null;
  installedAt: IsoTimestamp | null;
  verifiedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp | null;
}

export interface LocalSchedulingSetupStore {
  getLocalSchedulingSetup(): Promise<LocalSchedulingSetupState>;
  saveLocalSchedulingSetup(state: LocalSchedulingSetupState): Promise<void>;
}

export interface LocalSchedulingStateSource {
  isLocalSchedulingEnabled(): Promise<boolean>;
  getLocalSchedulingSetupState?(): Promise<LocalSchedulingSetupState>;
}

export interface LocalSchedulingSetupOptions {
  store: LocalSchedulingSetupStore;
  provider: WakeupProvider;
  request: WakeupTriggerRequest;
  clock: Clock;
}

export interface LocalSchedulingSetupResult {
  intent: WakeupTriggerIntent;
  state: LocalSchedulingSetupState;
  applied?: boolean;
}

export class LocalSchedulingSetup implements LocalSchedulingStateSource {
  private readonly store: LocalSchedulingSetupStore;
  private readonly provider: WakeupProvider;
  private readonly request: WakeupTriggerRequest;
  private readonly clock: Clock;

  constructor(options: LocalSchedulingSetupOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.request = options.request;
    this.clock = options.clock;
  }

  installIntent(): WakeupTriggerIntent {
    return this.provider.intentFor("install", this.request);
  }

  async install(): Promise<LocalSchedulingSetupResult> {
    const result = await this.provider.install(this.request);
    const now = this.nowIso();
    const state: LocalSchedulingSetupState = {
      enabled: result.applied,
      platform: result.applied ? this.provider.platform : null,
      triggerId: result.applied ? this.request.triggerId : null,
      installedAt: result.applied ? now : null,
      verifiedAt: null,
      updatedAt: now,
    };

    await this.store.saveLocalSchedulingSetup(state);
    return { intent: result.intent, state, applied: result.applied };
  }

  async verify(): Promise<LocalSchedulingSetupResult> {
    const current = await this.store.getLocalSchedulingSetup();
    if (
      !current.enabled ||
      current.platform !== this.provider.platform ||
      current.triggerId !== this.request.triggerId
    ) {
      throw new Error(
        "Persisted Local Scheduling setup does not match the expected trigger identity. Enable Local Scheduling again before verification.",
      );
    }
    const result = await this.provider.verify(this.request);
    const now = this.nowIso();
    const state: LocalSchedulingSetupState = {
      ...current,
      verifiedAt: result.applied ? now : current.verifiedAt,
      updatedAt: now,
    };

    await this.store.saveLocalSchedulingSetup(state);
    return { intent: result.intent, state, applied: result.applied };
  }

  async uninstall(): Promise<LocalSchedulingSetupResult> {
    const result = await this.provider.uninstall(this.request);
    const now = this.nowIso();
    const state: LocalSchedulingSetupState = result.applied
      ? {
          enabled: false,
          platform: null,
          triggerId: null,
          installedAt: null,
          verifiedAt: null,
          updatedAt: now,
        }
      : {
          ...(await this.store.getLocalSchedulingSetup()),
          updatedAt: now,
        };

    await this.store.saveLocalSchedulingSetup(state);
    return { intent: result.intent, state, applied: result.applied };
  }

  async isLocalSchedulingEnabled(): Promise<boolean> {
    return (await this.store.getLocalSchedulingSetup()).enabled;
  }

  async getLocalSchedulingSetupState(): Promise<LocalSchedulingSetupState> {
    return this.store.getLocalSchedulingSetup();
  }

  private nowIso(): IsoTimestamp {
    return this.clock.now().toISOString();
  }
}

export class WindowsTaskSchedulerWakeupProvider implements WakeupProvider {
  readonly platform = "windows";
  private readonly commandRunner: WakeupCommandRunner;

  constructor(options: WakeupProviderOptions = {}) {
    this.commandRunner = options.commandRunner ?? new NodeWakeupCommandRunner();
  }

  intentFor(
    operation: WakeupTriggerOperation,
    request: WakeupTriggerRequest,
  ): WakeupTriggerIntent {
    return {
      operation,
      platform: this.platform,
      triggerId: request.triggerId,
      intervalMinutes: request.intervalMinutes,
      workerCommand: renderCommandLine([
        request.workerExecutable,
        ...request.workerArguments,
      ]),
      commands: [this.commandFor(operation, request)],
      files: [],
    };
  }

  async install(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    const intent = this.intentFor("install", request);
    await applyWakeupIntent(intent, this.commandRunner);
    return { intent, applied: true };
  }

  async verify(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    const intent = this.intentFor("verify", request);
    const evidence = await this.commandRunner.run(intent.commands[0]!);
    return {
      intent,
      applied: windowsTaskMatchesRequest(evidence?.stdout ?? "", request),
    };
  }

  async uninstall(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    const intent = this.intentFor("uninstall", request);
    await applyWakeupIntent(intent, this.commandRunner);
    return { intent, applied: true };
  }

  private commandFor(
    operation: WakeupTriggerOperation,
    request: WakeupTriggerRequest,
  ): WakeupTriggerCommand {
    const args = taskSchedulerArgsFor(operation, request);
    return {
      executable: "schtasks.exe",
      args,
      shellCommand: renderCommandLine(["schtasks.exe", ...args]),
    };
  }
}

export class MacOsLaunchdWakeupProvider implements WakeupProvider {
  readonly platform = "macos";
  private readonly commandRunner: WakeupCommandRunner;
  private readonly fileWriter: WakeupFileWriter;
  private readonly fileReader: WakeupFileReader;

  constructor(options: WakeupProviderOptions = {}) {
    this.commandRunner = options.commandRunner ?? new NodeWakeupCommandRunner();
    this.fileWriter = options.fileWriter ?? new NodeWakeupFileWriter();
    this.fileReader = options.fileReader ?? new NodeWakeupFileReader();
  }

  intentFor(
    operation: WakeupTriggerOperation,
    request: WakeupTriggerRequest,
  ): WakeupTriggerIntent {
    return {
      operation,
      platform: this.platform,
      triggerId: request.triggerId,
      intervalMinutes: request.intervalMinutes,
      workerCommand: renderCommandLine([
        request.workerExecutable,
        ...request.workerArguments,
      ]),
      commands: this.commandsFor(operation, request),
      files:
        operation === "install"
          ? [
              {
                path: this.requirePlistPath(request),
                contents: launchdPlistFor(request),
              },
            ]
          : [],
    };
  }

  async install(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    const intent = this.intentFor("install", request);
    await applyWakeupIntent(intent, this.commandRunner, this.fileWriter);
    return { intent, applied: true };
  }

  async verify(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    const intent = this.intentFor("verify", request);
    const evidence = await this.commandRunner.run(intent.commands[0]!);
    let plistContents = "";
    try {
      plistContents = await this.fileReader.read(requireLaunchdPlistPath(request));
    } catch {
      return { intent, applied: false };
    }
    return {
      intent,
      applied:
        (evidence?.stdout ?? "").includes(
          `${launchdUserDomain(request)}/${request.triggerId}`,
        ) &&
        plistContents === launchdPlistFor(request),
    };
  }

  async uninstall(request: WakeupTriggerRequest): Promise<WakeupTriggerResult> {
    const intent = this.intentFor("uninstall", request);
    await applyWakeupIntent(intent, this.commandRunner, this.fileWriter);
    return { intent, applied: true };
  }

  private commandsFor(
    operation: WakeupTriggerOperation,
    request: WakeupTriggerRequest,
  ): WakeupTriggerCommand[] {
    const launchctlArgs = launchdArgsFor(operation, request);
    const commands: WakeupTriggerCommand[] = [
      {
        executable: "launchctl",
        args: launchctlArgs,
        shellCommand: renderCommandLine(["launchctl", ...launchctlArgs]),
      },
    ];

    if (operation === "uninstall") {
      const rmArgs = ["-f", requireLaunchdPlistPath(request)];
      commands.push({
        executable: "rm",
        args: rmArgs,
        shellCommand: renderCommandLine(["rm", ...rmArgs]),
      });
    }

    return commands;
  }

  private requirePlistPath(request: WakeupTriggerRequest): string {
    if (!request.launchdPlistPath) {
      throw new Error("launchd plist path is required for macOS wakeup setup.");
    }

    return request.launchdPlistPath;
  }
}

export function defaultLocalSchedulingSetupState(): LocalSchedulingSetupState {
  return {
    enabled: false,
    platform: null,
    triggerId: null,
    installedAt: null,
    verifiedAt: null,
    updatedAt: null,
  };
}

function taskSchedulerArgsFor(
  operation: WakeupTriggerOperation,
  request: WakeupTriggerRequest,
): string[] {
  switch (operation) {
    case "install":
      return [
        "/Create",
        "/TN",
        request.triggerId,
        "/SC",
        "MINUTE",
        "/MO",
        String(request.intervalMinutes),
        "/TR",
        renderCommandLine([
          request.workerExecutable,
          ...request.workerArguments,
        ]),
        "/F",
      ];
    case "verify":
      return ["/Query", "/TN", request.triggerId, "/XML"];
    case "uninstall":
      return ["/Delete", "/TN", request.triggerId, "/F"];
  }
}

function launchdArgsFor(
  operation: WakeupTriggerOperation,
  request: WakeupTriggerRequest,
): string[] {
  const userDomain = launchdUserDomain(request);
  switch (operation) {
    case "install":
      return ["bootstrap", userDomain, requireLaunchdPlistPath(request)];
    case "verify":
      return ["print", `${userDomain}/${request.triggerId}`];
    case "uninstall":
      return ["bootout", userDomain, requireLaunchdPlistPath(request)];
  }
}

function launchdPlistFor(request: WakeupTriggerRequest): string {
  const programArguments = [
    request.workerExecutable,
    ...request.workerArguments,
  ]
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(request.triggerId)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>StartInterval</key>
  <integer>${request.intervalMinutes * 60}</integer>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

function launchdUserDomain(request: WakeupTriggerRequest): string {
  if (request.userId === undefined) {
    throw new Error("User id is required for macOS wakeup setup.");
  }

  return `gui/${request.userId}`;
}

function requireLaunchdPlistPath(request: WakeupTriggerRequest): string {
  if (!request.launchdPlistPath) {
    throw new Error("launchd plist path is required for macOS wakeup setup.");
  }

  return request.launchdPlistPath;
}

function renderCommandLine(parts: string[]): string {
  return parts.map(quoteCommandPart).join(" ");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(part)) {
    return part;
  }

  return `"${part.replaceAll('"', '\\"')}"`;
}

function windowsTaskMatchesRequest(
  xml: string,
  request: WakeupTriggerRequest,
): boolean {
  const command = xmlTagValue(xml, "Command");
  const argumentsValue = xmlTagValue(xml, "Arguments");
  if (!command) {
    return false;
  }
  const actual = normalizeWindowsCommand(
    [command, argumentsValue].filter(Boolean).join(" "),
  );
  const expected = normalizeWindowsCommand(
    renderCommandLine([request.workerExecutable, ...request.workerArguments]),
  );
  return (
    actual === expected &&
    new RegExp(
      `<Interval>PT${request.intervalMinutes}M</Interval>`,
      "i",
    ).test(xml)
  );
}

function xmlTagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return decodeXml(match?.[1] ?? "").trim();
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function normalizeWindowsCommand(value: string): string {
  return value.replaceAll('"', "").replace(/\s+/g, " ").trim().toLowerCase();
}

class NodeWakeupCommandRunner implements WakeupCommandRunner {
  run(command: WakeupTriggerCommand): Promise<WakeupCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(
          new Error(
            `Wakeup trigger command failed with exit code ${code}: ${command.shellCommand}`,
          ),
        );
      });
    });
  }
}

class NodeWakeupFileReader implements WakeupFileReader {
  read(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
}

class NodeWakeupFileWriter implements WakeupFileWriter {
  async write(file: WakeupTriggerFile): Promise<void> {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, "utf8");
  }
}

async function applyWakeupIntent(
  intent: WakeupTriggerIntent,
  commandRunner: WakeupCommandRunner,
  fileWriter?: WakeupFileWriter,
): Promise<void> {
  if (intent.files.length > 0) {
    if (!fileWriter) {
      throw new Error("Wakeup trigger file writer is not configured.");
    }

    for (const file of intent.files) {
      await fileWriter.write(file);
    }
  }

  for (const command of intent.commands) {
    await commandRunner.run(command);
  }
}
