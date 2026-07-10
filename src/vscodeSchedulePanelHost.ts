import type {
  RunHistoryDetailView,
  ScheduleDetailView,
} from "./domain.js";
import type { ScheduleDetailRenderState } from "./vscodeScheduleRenderers.js";

interface DisposableLike {
  dispose(): unknown;
}

export interface SchedulePanelLike {
  title: string;
  visible?: boolean;
  webview: {
    html: string;
    postMessage?(message: unknown): PromiseLike<boolean>;
    onDidReceiveMessage?(
      listener: (message: unknown) => unknown,
    ): DisposableLike;
  };
  reveal?(showOptions?: unknown): unknown;
  dispose?(): unknown;
  onDidDispose?(listener: () => unknown): DisposableLike;
}

interface SchedulePanelHostOptions {
  subscriptions: DisposableLike[];
  createPanel(
    viewType: string,
    title: string,
    showOptions: unknown,
    options: { enableScripts: boolean; retainContextWhenHidden: boolean },
  ): SchedulePanelLike;
  viewColumn: unknown;
  scheduleViewType: string;
  runHistoryViewType: string;
  scheduleTitle(detail: ScheduleDetailView): string;
  renderSchedule(
    detail: ScheduleDetailView,
    state?: ScheduleDetailRenderState,
  ): Promise<string>;
  renderScheduleLive(
    detail: ScheduleDetailView,
  ): Promise<unknown>;
  renderRunHistory(detail: RunHistoryDetailView): string;
  renderRunHistoryLive(detail: RunHistoryDetailView): string;
  loadSchedule(scheduleId: string): Promise<ScheduleDetailView>;
  loadRunHistory(runId: string): Promise<RunHistoryDetailView>;
  onScheduleMessage(panel: SchedulePanelLike, message: unknown): unknown;
  onRunHistoryMessage(
    panel: SchedulePanelLike,
    runId: string,
    message: unknown,
  ): unknown;
  showError(message: string): Promise<unknown> | undefined;
}

export class VsCodeSchedulePanelHost {
  private readonly schedulePanels = new Map<string, SchedulePanelLike>();
  private readonly runHistoryPanels = new Map<string, SchedulePanelLike>();
  private readonly dirtySchedulePanels = new WeakSet<SchedulePanelLike>();
  private readonly interactingSchedulePanels = new WeakSet<SchedulePanelLike>();
  private readonly scheduleLiveSignatures = new WeakMap<SchedulePanelLike, string>();
  private readonly runHistoryLiveSignatures = new WeakMap<SchedulePanelLike, string>();

  constructor(private readonly options: SchedulePanelHostOptions) {}

  async openSchedule(detail: ScheduleDetailView): Promise<void> {
    const id = detail.schedule.id;
    const existing = this.schedulePanels.get(id);
    if (existing) {
      existing.reveal?.(this.options.viewColumn);
      await this.renderSchedule(existing, detail);
      return;
    }
    const panel = this.options.createPanel(
      this.options.scheduleViewType,
      this.options.scheduleTitle(detail),
      this.options.viewColumn,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.schedulePanels.set(id, panel);
    await this.renderSchedule(panel, detail);
    this.track(
      panel.onDidDispose?.(() => this.schedulePanels.delete(id)),
    );
    this.track(
      panel.webview.onDidReceiveMessage?.((message) =>
        this.options.onScheduleMessage(panel, message),
      ),
    );
  }

  async openRunHistory(runId: string): Promise<void> {
    const detail = await this.options.loadRunHistory(runId);
    const existing = this.runHistoryPanels.get(runId);
    if (existing) {
      existing.reveal?.(this.options.viewColumn);
      existing.webview.html = this.options.renderRunHistory(detail);
      return;
    }
    const panel = this.options.createPanel(
      this.options.runHistoryViewType,
      `Run ${runId}`,
      this.options.viewColumn,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = this.options.renderRunHistory(detail);
    this.runHistoryLiveSignatures.set(panel, this.options.renderRunHistoryLive(detail));
    this.runHistoryPanels.set(runId, panel);
    this.track(
      panel.onDidDispose?.(() => this.runHistoryPanels.delete(runId)),
    );
    this.track(
      panel.webview.onDidReceiveMessage?.((message) =>
        this.options.onRunHistoryMessage(panel, runId, message),
      ),
    );
  }

  async renderSchedule(
    panel: SchedulePanelLike,
    detail: ScheduleDetailView,
    state: ScheduleDetailRenderState = {},
  ): Promise<void> {
    this.dirtySchedulePanels.delete(panel);
    this.interactingSchedulePanels.delete(panel);
    panel.title = this.options.scheduleTitle(detail);
    panel.webview.html = await this.options.renderSchedule(detail, state);
    this.scheduleLiveSignatures.set(
      panel,
      JSON.stringify(await this.options.renderScheduleLive(detail)),
    );
  }

  async renderError(
    panel: SchedulePanelLike,
    scheduleId: string,
    message: string,
  ): Promise<void> {
    try {
      await this.renderSchedule(
        panel,
        await this.options.loadSchedule(scheduleId),
        { errorMessage: message },
      );
    } catch {
      await this.options.showError(`AgentScheduler: ${message}`);
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshSchedules(), this.refreshRunHistory()]);
  }

  hasVisiblePanels(): boolean {
    return [...this.schedulePanels.values(), ...this.runHistoryPanels.values()]
      .some((panel) => panel.visible !== false);
  }

  async refreshVisible(): Promise<void> {
    await Promise.all([
      this.syncSchedules(
        (panel) =>
          panel.visible !== false &&
          !this.dirtySchedulePanels.has(panel) &&
          !this.interactingSchedulePanels.has(panel),
      ),
      this.syncRunHistory((panel) => panel.visible !== false),
    ]);
  }

  private async syncSchedules(
    include: (panel: SchedulePanelLike) => boolean,
  ): Promise<void> {
    await Promise.all(
      [...this.schedulePanels.entries()].map(async ([id, panel]) => {
        if (!include(panel) || !panel.webview.postMessage) {
          return;
        }
        try {
          const detail = await this.options.loadSchedule(id);
          const state = await this.options.renderScheduleLive(detail);
          const signature = JSON.stringify(state);
          if (signature === this.scheduleLiveSignatures.get(panel)) {
            return;
          }
          const delivered = await panel.webview.postMessage({
            type: "schedule-live-state",
            state,
            refreshedAt: new Date().toISOString(),
          });
          if (delivered !== false) {
            this.scheduleLiveSignatures.set(panel, signature);
            panel.title = this.options.scheduleTitle(detail);
          }
        } catch {
          this.schedulePanels.delete(id);
        }
      }),
    );
  }

  markScheduleDirty(panel: SchedulePanelLike): void {
    this.dirtySchedulePanels.add(panel);
  }

  setScheduleInteraction(panel: SchedulePanelLike, active: boolean): void {
    if (active) {
      this.interactingSchedulePanels.add(panel);
    } else {
      this.interactingSchedulePanels.delete(panel);
    }
  }

  async refreshSchedules(
    include: (panel: SchedulePanelLike) => boolean = () => true,
  ): Promise<void> {
    await Promise.all(
      [...this.schedulePanels.entries()].map(async ([id, panel]) => {
        if (!include(panel)) {
          return;
        }
        try {
          await this.renderSchedule(
            panel,
            await this.options.loadSchedule(id),
          );
        } catch {
          this.schedulePanels.delete(id);
        }
      }),
    );
  }

  async refreshSchedulePanel(
    panel: SchedulePanelLike,
    scheduleId: string,
  ): Promise<void> {
    await this.renderSchedule(
      panel,
      await this.options.loadSchedule(scheduleId),
    );
  }

  disposeSchedule(scheduleId: string): void {
    this.schedulePanels.get(scheduleId)?.dispose?.();
    this.schedulePanels.delete(scheduleId);
  }

  async refreshRunHistoryPanel(
    panel: SchedulePanelLike,
    runId: string,
  ): Promise<void> {
    panel.webview.html = this.options.renderRunHistory(
      await this.options.loadRunHistory(runId),
    );
  }

  private async refreshRunHistory(
    include: (panel: SchedulePanelLike) => boolean = () => true,
  ): Promise<void> {
    await Promise.all(
      [...this.runHistoryPanels.entries()].map(async ([id, panel]) => {
        if (!include(panel)) {
          return;
        }
        try {
          await this.refreshRunHistoryPanel(panel, id);
        } catch {
          this.runHistoryPanels.delete(id);
        }
      }),
    );
  }

  private async syncRunHistory(include: (panel: SchedulePanelLike) => boolean): Promise<void> {
    await Promise.all([...this.runHistoryPanels.entries()].map(async ([id, panel]) => {
      if (!include(panel) || !panel.webview.postMessage) return;
      try {
        const html = this.options.renderRunHistoryLive(await this.options.loadRunHistory(id));
        if (html === this.runHistoryLiveSignatures.get(panel)) return;
        const delivered = await panel.webview.postMessage({ type: "run-history-live-state", html });
        if (delivered !== false) this.runHistoryLiveSignatures.set(panel, html);
      } catch { this.runHistoryPanels.delete(id); }
    }));
  }

  private track(disposable: DisposableLike | undefined): void {
    if (disposable) {
      this.options.subscriptions.push(disposable);
    }
  }
}
