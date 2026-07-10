import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { describeVsixBuild, packageVsix } from "./packageVsix.mjs";

test("describes a commit-qualified VSIX build", () => {
  assert.deepEqual(describeVsixBuild("0.1.0", "8d0588a"), {
    version: "0.1.0+8d0588a",
    filename: "agent-scheduler-0.1.0-8d0588a.vsix",
  });
});

test("rejects a commit identity that is not a hexadecimal Git SHA", () => {
  assert.throws(
    () => describeVsixBuild("0.1.0", "not-a-sha"),
    /Commit SHA must be 7 to 40 lowercase hexadecimal characters/,
  );
});

test("packages a commit-qualified VSIX without changing source manifests", async () => {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "agent-scheduler-package-"),
  );
  const packageJsonBefore = await readFile("package.json");
  const packageLockBefore = await readFile("package-lock.json");

  try {
    const result = await packageVsix({
      cwd: process.cwd(),
      commitSha: "abcdef1",
      outputDirectory,
    });

    assert.equal(basename(result.vsixPath), "agent-scheduler-0.1.0-abcdef1.vsix");
    assert.equal(result.version, "0.1.0+abcdef1");
    assert.equal(result.embeddedPackageVersion, result.version);
    assert.equal(result.embeddedManifestVersion, result.version);
    assert.deepEqual(await readFile("package.json"), packageJsonBefore);
    assert.deepEqual(await readFile("package-lock.json"), packageLockBefore);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
