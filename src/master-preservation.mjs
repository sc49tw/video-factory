// Master Preservation (P1): non-destructive preservation with verification-evidence-based status.
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const PRESERVATION_STATES = Object.freeze({
  MISSING: "MISSING",
  UNPROTECTED: "UNPROTECTED",
  PRESERVED: "PRESERVED",
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
});

const DEFAULT_MANIFEST_NAME = "preservation-manifest.json";

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
export function getPreservationConfigPath(factoryRoot) {
  return path.join(factoryRoot, "preservation.config.json");
}

export async function loadPreservationConfig(factoryRoot) {
  const configPath = getPreservationConfigPath(factoryRoot);
  try {
    const raw = await readFile(configPath, "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      return { targets: {}, defaultTarget: null };
    }
    return {
      targets: cfg.targets || {},
      defaultTarget: cfg.defaultTarget || null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { targets: {}, defaultTarget: null };
    }
    throw error;
  }
}

function normalizeTargetId(id) {
  if (!id || typeof id !== "string") return null;
  return id.trim();
}

export function resolveBackupPath(config, targetId) {
  const tid = normalizeTargetId(targetId);
  if (!tid) return null;
  const t = config.targets?.[tid];
  if (!t || typeof t !== "object") return null;
  if (typeof t.path !== "string" || !t.path) return null;
  return t.path;
}

export function manifestPath(preservationDir) {
  return path.join(preservationDir, DEFAULT_MANIFEST_NAME);
}
export async function checkBackupAvailability(backupPath) {
  try {
    await access(backupPath, fsConstants.R_OK);
    const st = await stat(backupPath);
    if (!st.isFile()) {
      return { available: false, reason: "not-file" };
    }
    return { available: true, reason: "ok" };
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") return { available: false, reason: "missing" };
    if (code === "EACCES") return { available: false, reason: "inaccessible" };
    return { available: false, reason: "unavailable" };
  }
}

export async function computeArtifactIdentity(artifactPath) {
  const st = await stat(artifactPath);
  if (!st.isFile()) throw new Error(`Artifact is not a file: ${artifactPath}`);
  const sha = await sha256File(artifactPath);
  return {
    filename: path.basename(artifactPath),
    path: artifactPath,
    sizeBytes: st.size,
    sha256: sha,
  };
}
function buildManifest({ episode, originalArtifact, preservationState, preservedAt, copies, verification }) {
  return {
    schemaVersion: "1.0",
    episode,
    preservationId: verification?.preservationId || null,
    originalArtifact: {
      filename: originalArtifact.filename,
      path: path.relative(process.cwd(), originalArtifact.path).replaceAll(path.sep, "/"),
      sha256: originalArtifact.sha256,
      sizeBytes: originalArtifact.sizeBytes,
      durationSec: originalArtifact.durationSec ?? null,
      resolution: originalArtifact.resolution ?? null,
      renderLabel: originalArtifact.renderLabel ?? null,
      subtitleQaPassed: originalArtifact.subtitleQaPassed ?? null,
      approvedAt: originalArtifact.approvedAt ?? null,
    },
    preservationState,
    preservedAt: preservedAt || null,
    copies: copies.map((c) => ({
      location: c.location || "external",
      storageType: c.storageType || "independent-physical-or-remote",
      targetId: c.targetId || null,
      reference: c.reference || null,
      path: c.path ? path.relative(process.cwd(), c.path).replaceAll(path.sep, "/") : null,
      sha256: c.sha256 || null,
      sizeBytes: c.sizeBytes || null,
      identicalToOriginal: !!c.identicalToOriginal,
      outsideRepo: c.outsideRepo === true,
      verifiedAt: c.verifiedAt || null,
      available: c.available ?? null,
    })),
    verification: {
      lastVerifiedAt: verification?.lastVerifiedAt || null,
      verifiedCount: verification?.verifiedCount || 0,
      status: verification?.status || "unknown",
      preservationId: verification?.preservationId || null,
    },
  };
}
export async function verifyPreservation({ factoryRoot, episode, preservationDir, config }) {
  const mpath = manifestPath(preservationDir);
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(mpath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, state: PRESERVATION_STATES.MISSING, reason: "manifest-missing" };
    return { ok: false, state: PRESERVATION_STATES.VERIFICATION_FAILED, reason: "manifest-read-failed" };
  }

  const orig = manifest.originalArtifact;
  if (!orig) return { ok: false, state: PRESERVATION_STATES.VERIFICATION_FAILED, reason: "missing-original-identity" };

  const artifactPath = path.isAbsolute(orig.path) ? orig.path : path.join(factoryRoot, orig.path);
  let art = null;
  try {
    art = await computeArtifactIdentity(artifactPath);
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") {
      return { ok: false, state: PRESERVATION_STATES.MISSING, reason: "original-missing", manifest };
    }
    return { ok: false, state: PRESERVATION_STATES.VERIFICATION_FAILED, reason: "original-unreadable", manifest };
  }

  if (orig.sha256 && art.sha256 !== orig.sha256) {
    return { ok: false, state: PRESERVATION_STATES.VERIFICATION_FAILED, reason: "original-hash-mismatch", manifest };
  }
  if (orig.sizeBytes != null && art.sizeBytes !== orig.sizeBytes) {
    return { ok: false, state: PRESERVATION_STATES.VERIFICATION_FAILED, reason: "original-size-mismatch", manifest };
  }

  let hasVerifiedExternalCopy = false;
  const copyResults = [];
  for (const c of manifest.copies || []) {
    const tid = c.targetId || null;
    let bpath = null;
    if (tid) {
      bpath = resolveBackupPath(config, tid);
    } else if (c.path) {
      bpath = path.isAbsolute(c.path) ? c.path : path.join(factoryRoot, c.path);
    } else if (c.reference) {
      bpath = c.reference;
    }
    const avail = await checkBackupAvailability(bpath);
    copyResults.push({ targetId: tid, available: avail.available, reason: avail.reason, bpath });
    if (!avail.available) {
      if (avail.reason === "missing") {
        // continue
      }
      continue;
    }
    try {
      const bst = await stat(bpath);
      const bsha = await sha256File(bpath);
      const sizeOk = (c.sizeBytes == null || bst.size === c.sizeBytes) && (orig.sizeBytes == null || bst.size === orig.sizeBytes);
      const shaOk = (c.sha256 == null || bsha === c.sha256) && (orig.sha256 == null || bsha === orig.sha256);
      if (sizeOk && shaOk) {
        if (c.outsideRepo === true) hasVerifiedExternalCopy = true;
      } else {
        return { ok: false, state: PRESERVATION_STATES.VERIFICATION_FAILED, reason: "backup-hash-or-size-mismatch", manifest, copyResults };
      }
    } catch {
      return { ok: false, state: PRESERVATION_STATES.VERIFICATION_FAILED, reason: "backup-unreadable", manifest, copyResults };
    }
  }

  if (!hasVerifiedExternalCopy) {
    const allMissing = copyResults.length > 0 && copyResults.every((r) => r.reason === "missing");
    if (allMissing) {
      return { ok: false, state: PRESERVATION_STATES.MISSING, reason: "no-verified-external-backup-and-copies-missing", manifest, copyResults };
    }
    return { ok: false, state: PRESERVATION_STATES.UNPROTECTED, reason: "verified-external-backup-not-available-now", manifest, copyResults };
  }

  return { ok: true, state: PRESERVATION_STATES.PRESERVED, reason: "verified", manifest, copyResults };
}
export async function preserveToTarget({ factoryRoot, episode, artifactPath, targetId, config, preservationDir }) {
  const tid = normalizeTargetId(targetId);
  if (!tid) throw new Error("targetId required (logical backup target)");
  const bpath = resolveBackupPath(config, tid);
  if (!bpath) throw new Error(`Unknown backup targetId: ${tid}`);

  await mkdir(preservationDir, { recursive: true });

  const art = await computeArtifactIdentity(artifactPath);
  const bdir = path.dirname(bpath);
  await mkdir(bdir, { recursive: true });

  try {
    await access(bpath, fsConstants.F_OK);
    throw new Error(`Backup target already exists and will not be overwritten: ${bpath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await copyFile(artifactPath, bpath);
  const bsha = await sha256File(bpath);
  const bst = await stat(bpath);
  if (bsha !== art.sha256) throw new Error("SHA-256 mismatch after copy");
  if (bst.size !== art.sizeBytes) throw new Error("Size mismatch after copy");

  const now = new Date().toISOString();
  const preservationId = `pres-${episode.toLowerCase()}-${Date.now()}`;
  const manifest = buildManifest({
    episode,
    originalArtifact: art,
    preservationState: PRESERVATION_STATES.UNPROTECTED,
    preservedAt: now,
    copies: [
      {
        location: "external",
        storageType: "independent-physical-or-remote",
        targetId: tid,
        path: bpath,
        sha256: bsha,
        sizeBytes: bst.size,
        identicalToOriginal: true,
        outsideRepo: true,
        verifiedAt: now,
      },
    ],
    verification: {
      lastVerifiedAt: now,
      verifiedCount: 1,
      status: "verified",
      preservationId,
    },
  });
  await writeFile(manifestPath(preservationDir), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { manifest };
}

async function copyFile(src, dst) {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(src);
    const ws = createWriteStream(dst, { flags: "wx" });
    rs.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    rs.pipe(ws);
  });
}
