import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const localVsce = resolve("node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const vsce = process.env.VSCE_PATH ?? (existsSync(localVsce) ? localVsce : undefined);
if (!vsce) {
  throw new Error("VSCE_PATH must point to a vsce executable when @vscode/vsce is not installed locally.");
}

const tempDirectory = mkdtempSync(join(tmpdir(), "agent-scheduler-vsix-smoke-"));
const vsixPath = join(tempDirectory, "agent-scheduler-smoke.vsix");
const extractedPath = join(tempDirectory, "extracted");

try {
  execFileSync(vsce, ["package", "-o", vsixPath], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  execFileSync("unzip", ["-q", vsixPath, "-d", extractedPath]);
  const workerPath = realpathSync(
    join(extractedPath, "extension", "dist", "src", "workerCli.js"),
  );

  for (const platform of ["windows", "macos"]) {
    const args = [
      workerPath,
      "local-scheduling",
      "install",
      "--dry-run",
      "--platform",
      platform,
      "--store",
      join(tempDirectory, `${platform}.sqlite`),
      "--node",
      process.execPath,
      "--worker",
      workerPath,
    ];
    if (platform === "macos") {
      args.push(
        "--user-id",
        "501",
        "--launchd-plist",
        join(tempDirectory, "com.bedugan.AgentScheduler.local-wakeup.plist"),
      );
    }
    const output = execFileSync(process.execPath, args, {
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.dryRun, true);
    assert.equal(result.platform, platform);
    assert.equal(result.operation, "install");
    assert.match(JSON.stringify(result), /scan-due-work/);
  }
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
