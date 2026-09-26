import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {validatePackageForSeries} from "./series-contracts.mjs";
import {validateEssyAssetsValidation} from "./essy-assets-validation.mjs";

export const DRAFT_STAGES = Object.freeze([
  "REQUEST",
  "CONCEPT",
  "ENGLISH",
  "PREPARE",
  "STORYBOARD",
  "PACKAGE",
  "ASSETS",
  "RENDER",
]);

export const ARTIFACTS = Object.freeze({
  REQUEST: "request.yaml",
  CONCEPT: "concept.yaml",
  ENGLISH: "script.yaml",
  STORYBOARD: "storyboard.yaml",
  PACKAGE: "production-package.json",
  ASSETS: "assets-validation.json",
});

const APPROVAL_FOR_STAGE = Object.freeze({
  CONCEPT: "concept",
  ENGLISH: "english",
  STORYBOARD: "scenes",
  PACKAGE: "package",
});

const NEXT_STAGE = Object.freeze({
  REQUEST: "CONCEPT",
  CONCEPT: "ENGLISH",
  ENGLISH: "STORYBOARD",
  PREPARE: "STORYBOARD",
  STORYBOARD: "PACKAGE",
  PACKAGE: "ASSETS",
  ASSETS: "RENDER",
});

// Canonical ESSY mapping (Runbook 5-phase):
//   WRITE   = draft ENGLISH
//   PREPARE = draft PREPARE (ESSY-only, no human approval gate)
//   DIRECT  = draft STORYBOARD (ESSY visual-slot planning, consumes PREPARE timing)
//   BUILD   = PACKAGE -> ASSETS -> RENDER (unchanged)
// Non-ESSY series keep the legacy ENGLISH -> STORYBOARD transition untouched.
export function nextStageForSeries(stage, series) {
  const normalized = String(stage ?? "").toUpperCase();
  if (normalized === "ENGLISH" && String(series ?? "").toUpperCase() === "ESSY") {
    return "PREPARE";
  }
  return NEXT_STAGE[normalized] ?? null;
}

export function isEssySeries(series) {
  return String(series ?? "").toUpperCase() === "ESSY";
}

export function draftRoot(factoryRoot, draftId) {
  return path.join(factoryRoot, "projects", "_drafts", draftId);
}

export function createDraftState({
  draftId,
  series,
  subtype,
  format = series,
  requestComplete = false,
}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "2.0",
    draftId,
    series,
    subtype,
    format,
    currentStage: requestComplete ? "CONCEPT" : "REQUEST",
    status: "in_progress",
    approvals: {
      concept: {approved: false},
      english: {approved: false},
      scenes: {approved: false},
      package: {approved: false},
    },
    artifacts: {
      request: "request.yaml",
      concept: null,
      script: null,
      storyboard: null,
      productionPackage: null,
    },
    createdAt: now,
    updatedAt: now,
    history: [{at: now, event: "draft-created"}],
  };
}

export async function readDraftState(factoryRoot, draftId) {
  const statePath = path.join(draftRoot(factoryRoot, draftId), "state.yaml");
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Invalid draft state ${statePath}: ${error.message}`);
  }
}

export async function writeDraftState(factoryRoot, state) {
  assertState(state);
  state.updatedAt = new Date().toISOString();
  const statePath = path.join(draftRoot(factoryRoot, state.draftId), "state.yaml");
  await mkdir(path.dirname(statePath), {recursive: true});
  // JSON is a strict subset of YAML, so this stays portable without adding
  // a runtime YAML parser dependency.
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return statePath;
}

export async function writeRequest(factoryRoot, state, request) {
  if (state.currentStage !== "REQUEST" && state.currentStage !== "CONCEPT") {
    throw new Error(`Request cannot be changed during ${state.currentStage}.`);
  }
  validateRequest(request, state);
  const requestPath = path.join(draftRoot(factoryRoot, state.draftId), ARTIFACTS.REQUEST);
  await mkdir(path.dirname(requestPath), {recursive: true});
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  if (state.currentStage === "REQUEST") {
    state.currentStage = "CONCEPT";
    record(state, "request-completed");
  }
  await writeDraftState(factoryRoot, state);
  return requestPath;
}

export async function submitStageArtifact(factoryRoot, state, stage, value) {
  stage = normalizeStage(stage);
  // ESSY WRITE text lives in script.md (frozen approved narration), not in a
  // submitted script.yaml. ESSY PREPARE completes deterministically via
  // recordPrepareComplete (verified TTS timing), not via artifact submit.
  if (isEssySeries(state.series) && (stage === "ENGLISH" || stage === "PREPARE")) {
    throw new Error(
      stage === "ENGLISH"
        ? "ESSY ENGLISH is approved from script.md, not a submitted script.yaml."
        : "ESSY PREPARE completes via verified TTS timing (prepare-complete), not artifact submit.",
    );
  }
  if (stage === "PREPARE") {
    throw new Error("PREPARE is ESSY-only and completes via verified TTS timing.");
  }
  if (isEssySeries(state.series) && stage === "STORYBOARD" && state?.prepare?.completed !== true) {
    throw new Error("ESSY STORYBOARD (DIRECT) requires completed PREPARE timing.");
  }
  if (state.currentStage !== stage) {
    throw new Error(`Cannot submit ${stage} while current stage is ${state.currentStage}.`);
  }
  if (!ARTIFACTS[stage]) throw new Error(`${stage} does not accept an artifact.`);
  validateStageArtifact(stage, value, state);
  const artifactPath = path.join(draftRoot(factoryRoot, state.draftId), ARTIFACTS[stage]);
  await mkdir(path.dirname(artifactPath), {recursive: true});
  await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const stateKey = {
    CONCEPT: "concept",
    ENGLISH: "script",
    STORYBOARD: "storyboard",
    PACKAGE: "productionPackage",
    ASSETS: "assetsValidation",
  }[stage];
  state.artifacts[stateKey] = ARTIFACTS[stage];
  if (stage === "ASSETS") {
    // ASSETS is a machine-only validation stage with NO human approval gate.
    // A passing validation deterministically completes the stage and advances
    // to RENDER; ESSY keeps exactly four human gates.
    state.currentStage = "RENDER";
    state.status = "in_progress";
    record(state, "assets-complete");
  } else {
    state.status = "needs_approval";
    record(state, `${stage.toLowerCase()}-submitted`);
  }
  await writeDraftState(factoryRoot, state);
  return artifactPath;
}

export async function approveDraftStage(factoryRoot, state, target) {
  const stage = stageForApproval(target);
  if (state.currentStage !== stage) {
    throw new Error(`Cannot approve ${target}; current stage is ${state.currentStage}.`);
  }
  // ESSY canonical English artifact is script.md (+ WRITE-side records);
  // every other series keeps the legacy script.yaml existence check exactly.
  if (stage === "ENGLISH" && isEssySeries(state.series)) {
    await assertEssyEnglishArtifact(factoryRoot, state);
  } else {
    const artifact = ARTIFACTS[stage];
    try {
      await readFile(path.join(draftRoot(factoryRoot, state.draftId), artifact), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Cannot approve ${target} before ${artifact} exists.`);
      }
      throw error;
    }
  }
  const approval = APPROVAL_FOR_STAGE[stage];
  state.approvals[approval] = {
    approved: true,
    approvedAt: new Date().toISOString(),
  };
  state.currentStage = nextStageForSeries(stage, state.series);
  state.status = stage === "PACKAGE" ? "package_approved" : "in_progress";
  record(state, `${approval}-approved`);
  await writeDraftState(factoryRoot, state);
  return state;
}

export async function rollbackDraft(factoryRoot, state, requestedStage) {
  const target = normalizeStage(requestedStage);
  const allowed = allowedRollbackTargets(state.currentStage, state.series);
  if (!allowed.includes(target)) {
    throw new Error(
      `Cannot roll back ${state.currentStage} to ${target}. Allowed: ${allowed.join(", ") || "none"}.`,
    );
  }
  for (const [stage, approval] of Object.entries(APPROVAL_FOR_STAGE)) {
    if (DRAFT_STAGES.indexOf(stage) >= DRAFT_STAGES.indexOf(target)) {
      state.approvals[approval] = {approved: false};
    }
  }
  for (const [stage, approval] of [
    ["ASSETS", "images"],
    ["RENDER", "qa"],
  ]) {
    if (
      state.approvals[approval] &&
      DRAFT_STAGES.indexOf(stage) >= DRAFT_STAGES.indexOf(target)
    ) {
      state.approvals[approval] = {approved: false};
    }
  }
  // Rolling back to (or through) PREPARE invalidates the deterministic
  // machine completion: timing must be re-verified before DIRECT resumes.
  if (DRAFT_STAGES.indexOf("PREPARE") >= DRAFT_STAGES.indexOf(target)) {
    state.prepare = {completed: false};
  }
  state.currentStage = target;
  state.status = "in_progress";
  record(state, "draft-rolled-back", {to: target});
  await writeDraftState(factoryRoot, state);
}

// Series-aware rollback graph. Non-ESSY series keep the legacy graph
// byte-for-byte (PREPARE is never a legal source or target there).
// ESSY inserts PREPARE between ENGLISH and STORYBOARD (= DIRECT).
export function allowedRollbackTargets(currentStage, series) {
  const current = String(currentStage ?? "").toUpperCase();
  if (!isEssySeries(series)) {
    return {
      CONCEPT: ["REQUEST"],
      ENGLISH: ["CONCEPT"],
      STORYBOARD: ["ENGLISH", "CONCEPT"],
      PACKAGE: ["STORYBOARD", "ENGLISH", "CONCEPT"],
      ASSETS: ["PACKAGE", "STORYBOARD", "ENGLISH", "CONCEPT"],
      RENDER: ["ASSETS", "PACKAGE", "STORYBOARD", "ENGLISH", "CONCEPT"],
    }[current] ?? [];
  }
  return {
    CONCEPT: ["REQUEST"],
    ENGLISH: ["CONCEPT"],
    PREPARE: ["ENGLISH", "CONCEPT"],
    STORYBOARD: ["PREPARE", "ENGLISH", "CONCEPT"],
    PACKAGE: ["STORYBOARD", "PREPARE", "ENGLISH", "CONCEPT"],
    ASSETS: ["PACKAGE", "STORYBOARD", "PREPARE", "ENGLISH", "CONCEPT"],
    RENDER: ["ASSETS", "PACKAGE", "STORYBOARD", "PREPARE", "ENGLISH", "CONCEPT"],
  }[current] ?? [];
}

export function validateStageArtifact(stage, value, state) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${stage} artifact must be an object.`);
  }
  if (stage === "CONCEPT") {
    requireStrings(value, [
      "workingTitle",
      "professionalFraming",
      "satiricalPremise",
      "learningObjective",
      "summary",
      "centralLesson",
    ]);
    requireNonEmptyArray(value.mainCharacters, "mainCharacters");
    requireNonEmptyArray(value.sceneOutline, "sceneOutline");
  } else if (stage === "ENGLISH") {
    requireNonEmptyArray(value.sentences, "sentences");
    for (const sentence of value.sentences) {
      const text = typeof sentence === "string" ? sentence : sentence?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("Every English sentence must contain non-empty text.");
      }
    }
  } else if (stage === "STORYBOARD") {
    // ESSY STORYBOARD is Runbook DIRECT: visual slots planned from actual
    // PREPARE timing. LLFC scenes/action/environment validation must NOT
    // apply to ESSY storyboard artifacts.
    if (isEssySeries(state?.series)) {
      validateEssyStoryboardArtifact(value, state);
    } else {
      requireNonEmptyArray(value.scenes, "scenes");
      for (const [index, scene] of value.scenes.entries()) {
        if (scene.scene !== index + 1) throw new Error("Storyboard scenes must be sequential.");
        requireStrings(scene, ["imageDescription", "action", "environment"]);
        requireNonEmptyArray(scene.sentences, `scenes[${index}].sentences`);
      }
    }
  } else if (stage === "PACKAGE") {
    // Series-specific contract dispatch: LLFC and ESSY package fields,
    // approval prerequisites, and validators live behind series-contracts.mjs.
    validatePackageForSeries(state.series, value, state);
  } else if (stage === "ASSETS") {
    // ESSY machine-only completion: validated production provenance +
    // bijection + media/duration-fit. No human approval gate exists here, and
    // LLFC/other series keep their legacy behavior (no ASSETS artifact).
    if (!isEssySeries(state.series)) {
      throw new Error("ASSETS artifact validation is ESSY-only.");
    }
    if (state.approvals.package?.approved !== true) {
      throw new Error("ASSETS completion requires approved package.");
    }
    validateEssyAssetsValidation(value, {
      draftId: state.draftId,
      series: state.series,
    });
  }
  return value;
}

function validateRequest(request, state) {
  requireStrings(request, ["draftId", "series", "subtype", "format", "sourceConcept"]);
  if (
    request.draftId !== state.draftId ||
    request.series !== state.series ||
    request.subtype !== state.subtype
  ) {
    throw new Error("Request identity must match draft state.");
  }
}

function assertState(state) {
  if (!state?.draftId || !DRAFT_STAGES.includes(state.currentStage)) {
    throw new Error("Invalid draft state.");
  }
}

function normalizeStage(value) {
  const stage = String(value ?? "").toUpperCase();
  if (!DRAFT_STAGES.includes(stage)) throw new Error(`Unknown draft stage "${value}".`);
  return stage;
}

function stageForApproval(target) {
  const normalized = String(target ?? "").toLowerCase();
  const result = Object.entries(APPROVAL_FOR_STAGE).find(
    ([, approval]) => approval === normalized,
  )?.[0];
  if (!result) {
    throw new Error("Draft approval target must be concept, english, scenes, or package.");
  }
  return result;
}

function requireStrings(value, fields) {
  for (const field of fields) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`Artifact requires non-empty "${field}".`);
    }
  }
}

function requireNonEmptyArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Artifact requires non-empty "${name}".`);
  }
}

// --- ESSY WRITE -> PREPARE -> DIRECT contract (Runbook 5-phase) ---

// ESSY canonical English artifact is the projects script.md (NOT
// script.yaml), plus the WRITE-side records declared on the draft state
// (titles.json / compression-review.md for ESSY-0004+). Older ESSY drafts
// only declare script.md; only declared records are enforced so frozen
// episodes keep their shape.
export async function assertEssyEnglishArtifact(factoryRoot, state) {
  const scriptPath = await resolveEssyWriteFile(factoryRoot, state, ["script", "script.md"]);
  if (!scriptPath) {
    throw new Error("Cannot approve english before script.md exists.");
  }
  const text = await readFile(scriptPath, "utf8");
  const blocks = parseEssyNarrationBlocks(text);
  if (blocks.length === 0) {
    throw new Error("script.md contains no narration blocks (expected ## N001, N002, ...).");
  }
  for (const block of blocks) {
    if (!block.text.trim()) {
      throw new Error(`script.md block ${block.id} must contain non-empty narration text.`);
    }
  }
  for (const key of ["titles", "compressionReview"]) {
    const declared = state.artifacts?.[key];
    if (typeof declared !== "string" || !declared) continue;
    const found = await resolveEssyWriteFile(factoryRoot, state, [key, declared]);
    if (!found) {
      throw new Error(`Cannot approve english before ${declared} exists.`);
    }
  }
  return {scriptPath, blockCount: blocks.length, blocks: blocks.map((block) => block.id)};
}

export function parseEssyNarrationBlocks(text) {
  const blocks = [];
  const pattern = /^##\s+(N\d{3})\b.*$/gm;
  const headings = [...String(text ?? "").matchAll(pattern)];
  for (const [index, heading] of headings.entries()) {
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    blocks.push({id: heading[1], text: text.slice(start, end)});
  }
  return blocks;
}

async function resolveEssyWriteFile(factoryRoot, state, candidates) {
  const roots = [
    draftRoot(factoryRoot, state.draftId),
    path.join(factoryRoot, "projects", state.draftId),
  ];
  const names = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    names.add(candidate);
    names.add(path.basename(candidate));
  }
  for (const root of roots) {
    for (const name of names) {
      const full = path.join(root, name);
      try {
        const info = await stat(full);
        if (info.isFile()) return full;
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

function record(state, event, detail = {}) {
  state.history ??= [];
  state.history.push({at: new Date().toISOString(), event, ...detail});
}

export async function recordPrepareComplete(factoryRoot, state) {
  if (!isEssySeries(state.series)) {
    throw new Error("PREPARE completion is ESSY-only.");
  }
  if (state.currentStage !== "PREPARE") {
    throw new Error(`Cannot complete PREPARE during ${state.currentStage}.`);
  }
  if (state.approvals?.english?.approved !== true) {
    throw new Error("Cannot complete PREPARE before english approval.");
  }
  const summary = await assertEssyPrepareTiming(factoryRoot, state);
  state.prepare = {completed: true, completedAt: new Date().toISOString(), ...summary};
  state.currentStage = "STORYBOARD";
  state.status = "in_progress";
  record(state, "prepare-complete", summary);
  await writeDraftState(factoryRoot, state);
  return state;
}

export async function assertEssyPrepareTiming(factoryRoot, state) {
  const episodeDir = path.join(factoryRoot, "projects", state.draftId);
  const manifestPath = path.join(episodeDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Cannot complete PREPARE before manifest.json exists.");
    }
    throw new Error(`Cannot complete PREPARE: invalid manifest.json (${error.message}).`);
  }
  const entries = manifest.audio;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Cannot complete PREPARE: manifest.json lists no audio entries.");
  }
  let totalDurationSec = 0;
  for (const entry of entries) {
    const id = entry?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("Cannot complete PREPARE: manifest audio entry is missing its id.");
    }
    if (typeof entry.durationSec !== "number" || !(entry.durationSec > 0)) {
      throw new Error(`Cannot complete PREPARE: audio entry ${id} has no positive durationSec.`);
    }
    if (typeof entry.textSha256 !== "string" || !entry.textSha256) {
      throw new Error(`Cannot complete PREPARE: audio entry ${id} is missing textSha256.`);
    }
    const audioPath = path.join(factoryRoot, entry.path);
    try {
      const info = await stat(audioPath);
      if (!info.isFile() || info.size === 0) {
        throw new Error(`Cannot complete PREPARE: audio file for ${id} is empty.`);
      }
    } catch (error) {
      if (error?.message?.startsWith("Cannot complete PREPARE")) throw error;
      throw new Error(`Cannot complete PREPARE: audio file for ${id} is missing.`);
    }
    const vttPath = path.join(episodeDir, "temp", `${id}.vtt`);
    try {
      await stat(vttPath);
    } catch {
      throw new Error(`Cannot complete PREPARE: temp/${id}.vtt is missing.`);
    }
    const wordsPath = path.join(episodeDir, "temp", `${id}.words.json`);
    let words;
    try {
      words = JSON.parse(await readFile(wordsPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Cannot complete PREPARE: temp/${id}.words.json is missing.`);
      }
      throw new Error(`Cannot complete PREPARE: temp/${id}.words.json is invalid (${error.message}).`);
    }
    assertEssyWordsArtifact(words, entry);
    totalDurationSec += entry.durationSec;
  }
  return {
    blockCount: entries.length,
    totalDurationSec: Math.round(totalDurationSec * 1000) / 1000,
    manifest: "manifest.json",
  };
}

function assertEssyWordsArtifact(words, entry) {
  const id = entry.id;
  if (words?.timingSource !== "edge-tts-word-boundary") {
    throw new Error(`Cannot complete PREPARE: temp/${id}.words.json is not edge-tts-word-boundary timing.`);
  }
  const cache = words.cacheIdentity;
  if (cache?.textSha256 !== entry.textSha256) {
    throw new Error(`Cannot complete PREPARE: temp/${id}.words.json textSha256 does not match manifest.`);
  }
  const manifestDuration = entry.durationSec;
  const wordsDuration = cache?.audioDurationSec;
  if (typeof wordsDuration !== "number" || Math.abs(wordsDuration - manifestDuration) > 0.01) {
    throw new Error(`Cannot complete PREPARE: temp/${id}.words.json audio duration does not match manifest.`);
  }
  const validation = words.validation;
  if (typeof validation?.wordCount !== "number" || validation.wordCount <= 0) {
    throw new Error(`Cannot complete PREPARE: temp/${id}.words.json has no words.`);
  }
  if (typeof validation?.lastWordEndSec !== "number" || !(validation.lastWordEndSec > 0)) {
    throw new Error(`Cannot complete PREPARE: temp/${id}.words.json has no word end timing.`);
  }
  if (validation.lastWordEndSec > manifestDuration + 1.5) {
    throw new Error(`Cannot complete PREPARE: temp/${id}.words.json timing exceeds audio duration.`);
  }
  if (!Array.isArray(words.words) || words.words.length === 0) {
    throw new Error(`Cannot complete PREPARE: temp/${id}.words.json has an empty words array.`);
  }
}

// ESSY STORYBOARD is Runbook DIRECT: visual slots planned FROM actual
// PREPARE timing (Visual Arc -> Slots -> editorialFunction -> visualIntent
// -> avoid + sequence literalness review). Valid only after PREPARE
// completion; slot count becomes concrete only here.
function validateEssyStoryboardArtifact(value, state) {
  if (state?.prepare?.completed !== true) {
    throw new Error("ESSY STORYBOARD (DIRECT) requires completed PREPARE timing.");
  }
  if (Array.isArray(value.scenes)) {
    throw new Error("ESSY storyboard uses blocks/slots, not LLFC scenes.");
  }
  requireNonEmptyArray(value.blocks, "blocks");
  for (const [index, block] of value.blocks.entries()) {
    if (typeof block?.narrationId !== "string" || !block.narrationId.trim()) {
      throw new Error(`ESSY storyboard blocks[${index}] requires a narrationId.`);
    }
    requireStrings(block, ["visualArc"]);
    requireNonEmptyArray(block.slots, `blocks[${index}].slots`);
    for (const [slotIndex, slot] of block.slots.entries()) {
      requireStrings(slot, ["slotId", "editorialFunction", "visualIntent"]);
      if (!Array.isArray(slot.avoid)) {
        throw new Error(`ESSY storyboard blocks[${index}].slots[${slotIndex}] requires an avoid list.`);
      }
    }
  }
  const reviewStatus = value.sequenceLiteralnessReview?.status;
  if (typeof reviewStatus !== "string" || !reviewStatus.trim()) {
    throw new Error("ESSY storyboard requires sequenceLiteralnessReview.status.");
  }
  return value;
}

// A draft-backed episode must never gain a competing production
// projects/<EP>/workflow.json while any draft stage still governs it.
// discover() and renderer lazy-create paths consult this guard before
// creating a parallel production workflow.
export function draftBlocksProductionWorkflow(state) {
  if (!state || typeof state.draftId !== "string") return false;
  return DRAFT_STAGES.includes(String(state.currentStage ?? "").toUpperCase());
}
