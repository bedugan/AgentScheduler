import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

const localVsce = resolve("node_modules", "@vscode", "vsce", "vsce");
const vsce = process.env.VSCE_PATH ?? (existsSync(localVsce) ? localVsce : undefined);
if (!vsce) {
  throw new Error("VSCE_PATH must point to a vsce executable when @vscode/vsce is not installed locally.");
}

const tempDirectory = mkdtempSync(join(tmpdir(), "agent-scheduler-vsix-smoke-"));
const vsixPath = join(tempDirectory, "agent-scheduler-smoke.vsix");
const extractedPath = join(tempDirectory, "extracted");

try {
  const vsceCommand = process.env.VSCE_PATH ? vsce : process.execPath;
  const vsceArgs = process.env.VSCE_PATH
    ? ["package", "-o", vsixPath]
    : [vsce, "package", "-o", vsixPath];
  execFileSync(vsceCommand, vsceArgs, {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  await extractZip(vsixPath, extractedPath);
  const workerPath = realpathSync(
    join(extractedPath, "extension", "dist", "src", "workerCli.js"),
  );

  const scan = JSON.parse(
    execFileSync(
      process.execPath,
      [
        workerPath,
        "scan-due-work",
        "--store",
        join(tempDirectory, "scan.sqlite"),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(scan.startedRunIds, []);
  assert.equal(scan.diagnostics.dueScheduleCount, 0);

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

function extractZip(zipPath, destination) {
  return new Promise((resolveExtraction, rejectExtraction) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        rejectExtraction(openError ?? new Error("Could not open VSIX archive."));
        return;
      }
      zip.on("error", rejectExtraction);
      zip.on("end", resolveExtraction);
      zip.on("entry", (entry) => {
        const entryPath = entry.fileName.replaceAll("\\", "/");
        if (entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
          zip.close();
          rejectExtraction(new Error(`Unsafe VSIX entry: ${entry.fileName}`));
          return;
        }
        const outputPath = join(destination, ...entryPath.split("/"));
        if (entryPath.endsWith("/")) {
          mkdirSync(outputPath, { recursive: true });
          zip.readEntry();
          return;
        }
        mkdirSync(dirname(outputPath), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            rejectExtraction(
              streamError ?? new Error(`Could not read ${entry.fileName}`),
            );
            return;
          }
          pipeline(stream, createWriteStream(outputPath)).then(
            () => zip.readEntry(),
            rejectExtraction,
          );
        });
      });
      zip.readEntry();
    });
  });
}
