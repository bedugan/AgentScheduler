import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COPILOT_CLI_AUTH_UNAVAILABLE_REASON,
  COPILOT_CLI_MISSING_REASON,
  CopilotCliLocalClient,
  classifyCopilotCliAvailability,
  type CopilotCliCommandResult,
  type CopilotCliCommandRunner,
} from "../src/index.js";

describe("Copilot CLI local client", () => {
  it("reports available when the CLI version probe succeeds", () => {
    assert.deepEqual(
      classifyCopilotCliAvailability({
        exitCode: 0,
        stdout: "GitHub Copilot CLI 1.0.25",
        stderr: "",
      }),
      {
        status: "available",
        approvalSurfaceAvailable: false,
      },
    );
  });

  it("tells the user how to fetch Copilot CLI when the command is missing", () => {
    const availability = classifyCopilotCliAvailability({
      exitCode: null,
      stdout: "",
      stderr: "",
      errorCode: "ENOENT",
      errorMessage: "spawn copilot ENOENT",
    });

    assert.deepEqual(availability, {
      status: "unavailable",
      reason: COPILOT_CLI_MISSING_REASON,
    });
    assert.match(availability.reason, /gh copilot/);
    assert.match(availability.reason, /PATH/);
  });

  it("tells the user how to authenticate when credentials are unavailable", () => {
    const availability = classifyCopilotCliAvailability({
      exitCode: null,
      stdout: "",
      stderr: "ERROR: SecItemCopyMatching failed -50",
    });

    assert.deepEqual(availability, {
      status: "unavailable",
      reason: COPILOT_CLI_AUTH_UNAVAILABLE_REASON,
    });
    assert.match(availability.reason, /copilot login/);
    assert.match(availability.reason, /COPILOT_GITHUB_TOKEN/);
  });

  it("checks availability lazily through the injected runner and caches the result", async () => {
    const runner = new RecordingCopilotCliCommandRunner({
      exitCode: 0,
      stdout: "GitHub Copilot CLI 1.0.25",
      stderr: "",
    });
    const client = new CopilotCliLocalClient({
      command: "/custom/copilot",
      runner,
    });

    assert.equal(client.currentAvailability(), undefined);
    assert.deepEqual(await client.checkAvailability(), {
      status: "available",
      approvalSurfaceAvailable: false,
    });
    assert.deepEqual(await client.checkAvailability(), {
      status: "available",
      approvalSurfaceAvailable: false,
    });

    assert.deepEqual(runner.calls, [
      { command: "/custom/copilot", args: ["--version"] },
    ]);
  });
});

class RecordingCopilotCliCommandRunner implements CopilotCliCommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  private readonly result: CopilotCliCommandResult;

  constructor(result: CopilotCliCommandResult) {
    this.result = result;
  }

  async run(
    command: string,
    args: readonly string[],
  ): Promise<CopilotCliCommandResult> {
    this.calls.push({ command, args: [...args] });
    return this.result;
  }
}
