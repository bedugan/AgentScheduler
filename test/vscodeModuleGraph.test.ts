import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("VS Code module dependency graph", () => {
  it("keeps extracted modules below the adapter composition surface", async () => {
    const internalModules = [
      "vscodeContracts",
      "vscodeCopilotTaskExecutor",
      "vscodeLocalScheduling",
      "vscodeNaturalLanguageScheduleCreation",
      "vscodeScheduleController",
      "vscodeScheduleDetailMessages",
      "vscodeSchedulePanelHost",
      "vscodeScheduleRenderers",
    ];

    for (const moduleName of internalModules) {
      const source = await readFile(`src/${moduleName}.ts`, "utf8");
      assert.doesNotMatch(
        source,
        /from ["']\.\/vscodeExtensionAdapter\.js["']/,
        `${moduleName} must not import the adapter composition surface`,
      );
    }

    const controller = await readFile("src/vscodeScheduleController.ts", "utf8");
    assert.match(controller, /from "\.\/vscodeContracts\.js"/);
    const adapter = await readFile("src/vscodeExtensionAdapter.ts", "utf8");
    assert.match(adapter, /export \* from "\.\/vscodeContracts\.js"/);
  });

  it("routes every VS Code schedule operation through the editor control surface", async () => {
    const modulesWithoutRawLifecycleAccess = [
      "vscodeContracts",
      "vscodeNaturalLanguageScheduleCreation",
      "vscodeScheduleController",
    ];

    for (const moduleName of modulesWithoutRawLifecycleAccess) {
      const source = await readFile(`src/${moduleName}.ts`, "utf8");
      assert.doesNotMatch(
        source,
        /scheduleLifecycle\.js/,
        `${moduleName} must depend on the editor control surface, not ScheduleLifecycle`,
      );
    }

    const adapter = await readFile("src/vscodeExtensionAdapter.ts", "utf8");
    assert.doesNotMatch(
      adapter,
      /\n\s{4}lifecycle,\n\s{4}localSchedulingSetupAvailability/,
      "the composition surface must not expose its raw lifecycle",
    );
  });
});
