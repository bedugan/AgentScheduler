export interface ScheduleModelOption {
  id: string;
  displayName: string;
  vendor?: string;
  family?: string;
  version?: string;
  maxInputTokens?: number;
}

export interface ScheduleModelCatalog {
  listScheduleModels(): Promise<readonly ScheduleModelOption[]>;
  onDidChangeScheduleModels?: (
    listener: () => unknown,
  ) => { dispose(): unknown };
}

export function preferredScheduleModel(
  models: readonly ScheduleModelOption[],
): ScheduleModelOption | undefined {
  return models[0];
}

export function isScheduleModelAvailable(
  modelId: string,
  models: readonly ScheduleModelOption[],
): boolean {
  return models.some((model) => model.id === modelId);
}

export function unavailableScheduleModelMessage(modelId: string): string {
  return `Selected model '${modelId}' is not available in this VS Code/Copilot environment. Choose an available model or refresh VS Code's chat model list.`;
}
