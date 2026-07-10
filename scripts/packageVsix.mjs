import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import yauzl from "yauzl";

const execFile = promisify(execFileCallback);

export function describeVsixBuild(baseVersion, commitSha) {
  if (!/^[0-9a-f]{7,40}$/.test(commitSha)) {
    throw new Error(
      "Commit SHA must be 7 to 40 lowercase hexadecimal characters.",
    );
  }
  return {
    version: `${baseVersion}+${commitSha}`,
    filename: `agent-scheduler-${baseVersion}-${commitSha}.vsix`,
  };
}

export async function packageVsix({
  cwd = process.cwd(),
  commitSha,
  outputDirectory = cwd,
  vscePath = process.env.VSCE_PATH,
} = {}) {
  const resolvedCommitSha = commitSha ?? await currentCommitSha(cwd);
  const sourcePackagePath = join(cwd, "package.json");
  const sourceLockPath = join(cwd, "package-lock.json");
  const packageJsonBefore = await readFile(sourcePackagePath);
  const packageLockBefore = await readFile(sourceLockPath);
  const manifest = JSON.parse(packageJsonBefore.toString("utf8"));
  const build = describeVsixBuild(manifest.version, resolvedCommitSha);
  await mkdir(outputDirectory, { recursive: true });
  const vsixPath = resolve(outputDirectory, build.filename);

  const localVsce = resolve(cwd, "node_modules", "@vscode", "vsce", "vsce");
  const executable =
    vscePath ?? (existsSync(localVsce) ? process.execPath : undefined);
  if (!executable) {
    throw new Error(
      "VSCE_PATH must point to a vsce executable when @vscode/vsce is not installed locally.",
    );
  }
  const args = vscePath
    ? ["package", build.version, "--no-update-package-json", "-o", vsixPath]
    : [
        localVsce,
        "package",
        build.version,
        "--no-update-package-json",
        "-o",
        vsixPath,
      ];
  await execFile(executable, args, { cwd, maxBuffer: 10 * 1024 * 1024 });

  const packageJsonAfter = await readFile(sourcePackagePath);
  const packageLockAfter = await readFile(sourceLockPath);
  if (
    !packageJsonAfter.equals(packageJsonBefore) ||
    !packageLockAfter.equals(packageLockBefore)
  ) {
    throw new Error("VSIX packaging changed package.json or package-lock.json.");
  }

  const embeddedPackage = JSON.parse(
    (await readZipEntry(vsixPath, "extension/package.json")).toString("utf8"),
  );
  const vsixManifest = (
    await readZipEntry(vsixPath, "extension.vsixmanifest")
  ).toString("utf8");
  const embeddedManifestVersion = identityVersion(vsixManifest);
  if (embeddedPackage.version !== build.version) {
    throw new Error(
      `Packaged extension version '${embeddedPackage.version}' does not match '${build.version}'.`,
    );
  }
  if (embeddedManifestVersion !== build.version) {
    throw new Error(
      `VSIX manifest version '${embeddedManifestVersion}' does not match '${build.version}'.`,
    );
  }
  if (!basename(vsixPath).includes(resolvedCommitSha)) {
    throw new Error("VSIX filename does not include the commit SHA.");
  }

  return {
    vsixPath,
    version: build.version,
    embeddedPackageVersion: embeddedPackage.version,
    embeddedManifestVersion,
  };
}

async function currentCommitSha(cwd) {
  const { stdout } = await execFile("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd,
  });
  return stdout.trim();
}

function identityVersion(xml) {
  const identity = /<Identity\b[^>]*\bVersion="([^"]+)"/i.exec(xml);
  if (!identity?.[1]) {
    throw new Error("VSIX manifest does not contain an Identity Version.");
  }
  return identity[1];
}

function readZipEntry(zipPath, expectedPath) {
  return new Promise((resolveEntry, rejectEntry) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        rejectEntry(openError ?? new Error(`Could not open ${zipPath}.`));
        return;
      }
      let settled = false;
      const reject = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        rejectEntry(error);
      };
      zip.on("error", reject);
      zip.on("end", () => {
        if (!settled) {
          reject(new Error(`VSIX is missing ${expectedPath}.`));
        }
      });
      zip.on("entry", (entry) => {
        if (entry.fileName !== expectedPath) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Could not read ${expectedPath}.`));
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            if (settled) return;
            settled = true;
            zip.close();
            resolveEntry(Buffer.concat(chunks));
          });
        });
      });
      zip.readEntry();
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await packageVsix({
    ...(process.argv[2] ? { outputDirectory: resolve(process.argv[2]) } : {}),
  });
  process.stdout.write(`${result.vsixPath}\n`);
}
