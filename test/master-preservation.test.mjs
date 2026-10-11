import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PRESERVATION_STATES,
  getPreservationConfigPath,
  loadPreservationConfig,
  manifestPath,
  checkBackupAvailability,
  computeArtifactIdentity,
  verifyPreservation,
  preserveToTarget,
} from "../src/master-preservation.mjs";

async function makeRoot() {
  return mkdtemp(path.join(os.tmpdir(), "vf-pres-"));
}

test("preserveToTarget creates Git-trackable manifest with verification after copy", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = root;
    const episode = "ESSY-P1-001";
    const artifactDir = path.join(factoryRoot, "output", episode);
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, `${episode}-final-v2.mp4`);
    await writeFile(artifactPath, Buffer.from("fake-master-bytes-for-p1"));
    const backupPath = path.join(factoryRoot, ".preservation-test", `${episode}-final-v2.mp4`);
    await mkdir(path.dirname(backupPath), { recursive: true });
    const config = { targets: { "backup-external-1": { path: backupPath, outsideRepo: true } }, defaultTarget: "backup-external-1" };
    await writeFile(getPreservationConfigPath(factoryRoot), JSON.stringify(config, null, 2));
    const preservationDir = path.join(factoryRoot, "preservation", episode);
    const res = await preserveToTarget({ factoryRoot, episode, artifactPath, targetId: "backup-external-1", config, preservationDir });
    assert.ok(res.manifest);
    assert.equal(res.manifest.schemaVersion, "1.0");
    assert.equal(res.manifest.episode, episode);
    assert.ok(res.manifest.preservationId);
    assert.equal(res.manifest.copies[0].outsideRepo, true);
    const v = await verifyPreservation({ factoryRoot, episode, preservationDir, config });
    assert.equal(v.ok, true);
    assert.equal(v.state, PRESERVATION_STATES.PRESERVED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
