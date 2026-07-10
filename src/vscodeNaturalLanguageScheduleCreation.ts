import type {
  ApprovalMode,
  CreateActiveScheduleInput,
  CreateDraftScheduleInput,
  HarnessMode,
  RunCadence,
  RunCapInput,
  Schedule,
  TargetContext,
  WorkspaceTargetContext,
} from "./domain.js";
import type { ScheduleLifecycle } from "./scheduleLifecycle.js";
import type {
  ScheduleModelCatalog,
  ScheduleModelOption,
} from "./scheduleModelCatalog.js";
import {
  isScheduleModelAvailable,
  unavailableScheduleModelMessage,
} from "./scheduleModelCatalog.js";

export type NaturalLanguageScheduleCreationSource =
  | "language-model-tool"
  | "chat-participant"
  | "slash-command";

export type NaturalLanguageScheduleCreationOutcome = "activated" | "draft";

export interface NaturalLanguageScheduleCreationInput {
  naturalLanguageRequest: string;
  runInstructions?: string;
  cadence?: RunCadence;
  targetContext?: TargetContext;
  harnessMode?: HarnessMode;
  model?: string;
  approvalMode?: ApprovalMode;
  runCap?: RunCapInput;
  riskWarnings?: string[];
}

export type NaturalLanguageScheduleActivationProposal =
  CreateActiveScheduleInput;

export interface NaturalLanguageScheduleCreationResult {
  source: NaturalLanguageScheduleCreationSource;
  outcome: NaturalLanguageScheduleCreationOutcome;
  schedule: Schedule;
  validationMessages: string[];
}

export interface NaturalLanguageScheduleCreationTool {
  name: "agentScheduler.createSchedule";
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(
    input: NaturalLanguageScheduleCreationInput,
  ): Promise<NaturalLanguageScheduleCreationResult>;
}

export interface NaturalLanguageScheduleCreationChatParticipant {
  id: "agentScheduler.schedule";
  handleRequest(
    input: NaturalLanguageScheduleCreationInput,
  ): Promise<NaturalLanguageScheduleCreationResult>;
}

export interface NaturalLanguageScheduleCreationSlashCommand {
  command: "agentScheduler.createSchedule";
  execute(
    input: NaturalLanguageScheduleCreationInput,
  ): Promise<NaturalLanguageScheduleCreationResult>;
}

export interface VsCodeNaturalLanguageScheduleCreationOptions {
  lifecycle: ScheduleLifecycle;
  currentWorkspace?: WorkspaceTargetContext;
  defaultModel?: string;
  modelCatalog?: ScheduleModelCatalog;
  confirmActivation(
    proposal: NaturalLanguageScheduleActivationProposal,
  ): Promise<boolean>;
}

export const naturalLanguageScheduleCreationInputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["naturalLanguageRequest"],
  properties: {
    naturalLanguageRequest: {
      type: "string",
      description: "The user's natural-language schedule creation request.",
    },
    runInstructions: {
      type: "string",
      description: "Inline instructions to run each time the schedule fires.",
    },
    cadence: {
      type: "object",
      additionalProperties: false,
      required: ["type", "expression"],
      properties: {
        type: { const: "cron" },
        expression: { type: "string" },
      },
    },
    targetContext: {
      type: "object",
      additionalProperties: false,
      required: ["type", "uri"],
      properties: {
        type: { const: "workspace" },
        uri: { type: "string" },
        label: { type: "string" },
      },
    },
    harnessMode: {
      type: "string",
      enum: ["local-copilot", "cloud-copilot"],
    },
    model: { type: "string" },
    approvalMode: {
      type: "string",
      enum: ["default-approvals", "bypass-approvals", "autopilot"],
    },
    runCap: {
      type: "object",
      additionalProperties: false,
      required: ["maxRuns"],
      properties: {
        maxRuns: { type: "integer", minimum: 1 },
      },
    },
    riskWarnings: {
      type: "array",
      items: { type: "string" },
    },
  },
};

export class VsCodeNaturalLanguageScheduleCreationFlow {
  readonly languageModelTool: NaturalLanguageScheduleCreationTool;
  readonly chatParticipant: NaturalLanguageScheduleCreationChatParticipant;
  readonly slashCommand: NaturalLanguageScheduleCreationSlashCommand;

  private readonly lifecycle: ScheduleLifecycle;
  private readonly currentWorkspace: WorkspaceTargetContext | undefined;
  private readonly defaultModel: string;
  private readonly modelCatalog: ScheduleModelCatalog | undefined;
  private readonly confirmActivation: (
    proposal: NaturalLanguageScheduleActivationProposal,
  ) => Promise<boolean>;

  constructor(options: VsCodeNaturalLanguageScheduleCreationOptions) {
    this.lifecycle = options.lifecycle;
    this.currentWorkspace = options.currentWorkspace;
    this.defaultModel = options.defaultModel ?? "gpt-5";
    this.modelCatalog = options.modelCatalog;
    this.confirmActivation = options.confirmActivation;

    this.languageModelTool = {
      name: "agentScheduler.createSchedule",
      description:
        "Create an AgentScheduler schedule from a natural-language request.",
      inputSchema: naturalLanguageScheduleCreationInputSchema,
      invoke: (input) =>
        this.createFromNaturalLanguage(input, "language-model-tool"),
    };
    this.chatParticipant = {
      id: "agentScheduler.schedule",
      handleRequest: (input) =>
        this.createFromNaturalLanguage(input, "chat-participant"),
    };
    this.slashCommand = {
      command: "agentScheduler.createSchedule",
      execute: (input) =>
        this.createFromNaturalLanguage(input, "slash-command"),
    };
  }

  async invokeLanguageModelTool(
    input: NaturalLanguageScheduleCreationInput,
  ): Promise<NaturalLanguageScheduleCreationResult> {
    return this.languageModelTool.invoke(input);
  }

  async handleChatParticipantRequest(
    input: NaturalLanguageScheduleCreationInput,
  ): Promise<NaturalLanguageScheduleCreationResult> {
    return this.chatParticipant.handleRequest(input);
  }

  async executeSlashCommand(
    input: NaturalLanguageScheduleCreationInput,
  ): Promise<NaturalLanguageScheduleCreationResult> {
    return this.slashCommand.execute(input);
  }

  private async createFromNaturalLanguage(
    input: NaturalLanguageScheduleCreationInput,
    source: NaturalLanguageScheduleCreationSource,
  ): Promise<NaturalLanguageScheduleCreationResult> {
    const availableModels = await this.listAvailableModels();
    const draftInput = this.buildDraftInput(input, availableModels);
    const validationMessages = [
      ...activationValidationMessages(draftInput),
      ...harnessAvailabilityValidationMessages(this.lifecycle, draftInput),
      ...modelValidationMessages(draftInput, availableModels),
      ...riskValidationMessages(input.naturalLanguageRequest),
      ...(input.riskWarnings ?? []),
    ];

    if (validationMessages.length > 0) {
      const schedule = await this.lifecycle.createDraftSchedule(draftInput);
      return {
        source,
        outcome: "draft",
        schedule,
        validationMessages,
      };
    }

    const proposal = toActivationProposal(draftInput);
    const confirmed = await this.confirmActivation(proposal);
    if (!confirmed) {
      const schedule = await this.lifecycle.createDraftSchedule(draftInput);
      return {
        source,
        outcome: "draft",
        schedule,
        validationMessages: ["Activation was not confirmed."],
      };
    }

    const schedule = await this.lifecycle.createActiveSchedule(proposal);
    return {
      source,
      outcome: "activated",
      schedule,
      validationMessages: [],
    };
  }

  private buildDraftInput(
    input: NaturalLanguageScheduleCreationInput,
    availableModels: readonly ScheduleModelOption[],
  ): CreateDraftScheduleInput {
    const runInstructions = normalizedRunInstructionsFrom(
      input.runInstructions ?? input.naturalLanguageRequest,
    );
    const cadence = input.cadence ?? inferCadence(input.naturalLanguageRequest);
    const targetContext = input.targetContext ?? this.currentWorkspace;
    const harnessMode =
      input.harnessMode ??
      inferHarnessMode(input.naturalLanguageRequest) ??
      "local-copilot";
    const model =
      normalizeText(input.model) ?? availableModels[0]?.id ?? this.defaultModel;
    const approvalMode = input.approvalMode ?? "default-approvals";

    const proposal: CreateDraftScheduleInput = {
      runInstructions: runInstructions ?? input.naturalLanguageRequest.trim(),
      cadence: cadence ?? null,
      targetContext: targetContext ?? null,
      harnessMode,
      model,
      approvalMode,
    };

    if (input.runCap) {
      proposal.runCap = input.runCap;
    }

    return proposal;
  }

  private async listAvailableModels(): Promise<readonly ScheduleModelOption[]> {
    if (!this.modelCatalog) {
      return [];
    }

    return this.modelCatalog.listScheduleModels();
  }
}

function activationValidationMessages(
  input: CreateDraftScheduleInput,
): string[] {
  const messages: string[] = [];
  if (input.runInstructions.trim().length === 0) {
    messages.push("Run instructions are required before activation.");
  }
  if (!input.cadence) {
    messages.push("Run cadence is required before activation.");
  }
  if (!input.targetContext) {
    messages.push("Target context is required before activation.");
  }
  if (!input.harnessMode) {
    messages.push("Harness mode is required before activation.");
  }
  return messages;
}

function modelValidationMessages(
  input: CreateDraftScheduleInput,
  availableModels: readonly ScheduleModelOption[],
): string[] {
  if (
    availableModels.length > 0 &&
    !isScheduleModelAvailable(input.model, availableModels)
  ) {
    return [unavailableScheduleModelMessage(input.model)];
  }

  return [];
}

function harnessAvailabilityValidationMessages(
  lifecycle: ScheduleLifecycle,
  input: CreateDraftScheduleInput,
): string[] {
  if (!input.harnessMode) {
    return [];
  }

  const availability = lifecycle.harnessModeAvailabilityFor(input.harnessMode);
  return availability.available
    ? []
    : [
        availability.reason ??
          `${availability.label} is unavailable in this VS Code environment.`,
      ];
}

function riskValidationMessages(request: string): string[] {
  if (
    /\b(delete|remove|destroy|drop|overwrite|force[-\s]?push)\b/i.test(
      request,
    ) ||
    /\brm\s+-rf\b/i.test(request)
  ) {
    return [
      "Request includes potentially destructive work and must be reviewed before automatic recurrence.",
    ];
  }

  return [];
}

function toActivationProposal(
  input: CreateDraftScheduleInput,
): NaturalLanguageScheduleActivationProposal {
  if (
    input.runInstructions.trim().length === 0 ||
    !input.cadence ||
    !input.targetContext ||
    !input.harnessMode
  ) {
    throw new Error("Cannot activate an incomplete natural-language schedule.");
  }

  const proposal: CreateActiveScheduleInput = {
    runInstructions: input.runInstructions,
    cadence: input.cadence,
    targetContext: input.targetContext,
    harnessMode: input.harnessMode,
    model: input.model,
    approvalMode: input.approvalMode,
  };

  if (input.runCap) {
    proposal.runCap = input.runCap;
  }

  return proposal;
}

function inferCadence(request: string): RunCadence | undefined {
  const normalized = request.toLowerCase();

  if (/\b(every hour|hourly)\b/.test(normalized)) {
    return { type: "cron", expression: "0 * * * *" };
  }

  const minuteMatch = /\bevery\s+([1-9]\d?)\s+minutes?\b/.exec(normalized);
  if (minuteMatch?.[1]) {
    return { type: "cron", expression: `*/${minuteMatch[1]} * * * *` };
  }

  if (/\b(every day|daily)\b/.test(normalized)) {
    return { type: "cron", expression: "0 9 * * *" };
  }

  if (/\b(every week|weekly)\b/.test(normalized)) {
    return { type: "cron", expression: "0 9 * * 1" };
  }

  return undefined;
}

function inferHarnessMode(request: string): HarnessMode | undefined {
  const normalized = request.toLowerCase();

  if (
    /\bcloud\s+copilot\b/.test(normalized) ||
    /\bcopilot\s+cloud\b/.test(normalized) ||
    /\bcloud\s+(agent|execution|mode)\b/.test(normalized)
  ) {
    return "cloud-copilot";
  }

  if (
    /\blocal\s+copilot\b/.test(normalized) ||
    /\bcopilot\s+local\b/.test(normalized) ||
    /\blocal\s+(agent|execution|mode)\b/.test(normalized)
  ) {
    return "local-copilot";
  }

  return undefined;
}

function normalizedRunInstructionsFrom(request: string): string | undefined {
  const singleRunRequest = stripCadenceControlText(request);
  const match = /\bto\s+(.+)$/i.exec(singleRunRequest);
  return normalizeSentence(match?.[1] ?? singleRunRequest);
}

function stripCadenceControlText(request: string): string {
  const normalized = request.trim().replace(/\s+/g, " ");
  const cadencePattern =
    "(?:every\\s+hour|hourly|every\\s+[1-9]\\d?\\s+minutes?|every\\s+day|daily|every\\s+week|weekly)";
  const recurrencePrefix = new RegExp(
    `^(?:(?:run|do|perform)\\s+)?${cadencePattern}\\s+(?:and|to)\\s+(.+)$`,
    "i",
  );
  const match = recurrencePrefix.exec(normalized);

  return match?.[1] ?? normalized;
}

function normalizeSentence(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }

  const sentence = `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : undefined;
}
