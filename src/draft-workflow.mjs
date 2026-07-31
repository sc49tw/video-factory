import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {validateProductionPackage} from "./production-package.mjs";

export const DRAFT_STAGES = Object.freeze([
  "REQUEST",
  "CONCEPT",
  "ENGLISH",
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
  STORYBOARD: "PACKAGE",
  PACKAGE: "ASSETS",
  ASSETS: "RENDER",
});

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
  }[stage];
  state.artifacts[stateKey] = ARTIFACTS[stage];
  state.status = "needs_approval";
  record(state, `${stage.toLowerCase()}-submitted`);
  await writeDraftState(factoryRoot, state);
  return artifactPath;
}

export async function approveDraftStage(factoryRoot, state, target) {
  const stage = stageForApproval(target);
  if (state.currentStage !== stage) {
    throw new Error(`Cannot approve ${target}; current stage is ${state.currentStage}.`);
  }
  const artifact = ARTIFACTS[stage];
  try {
    await readFile(path.join(draftRoot(factoryRoot, state.draftId), artifact), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Cannot approve ${target} before ${artifact} exists.`);
    }
    throw error;
  }
  const approval = APPROVAL_FOR_STAGE[stage];
  state.approvals[approval] = {
    approved: true,
    approvedAt: new Date().toISOString(),
  };
  state.currentStage = NEXT_STAGE[stage];
  state.status = stage === "PACKAGE" ? "package_approved" : "in_progress";
  record(state, `${approval}-approved`);
  await writeDraftState(factoryRoot, state);
  return state;
}

export async function rollbackDraft(factoryRoot, state, requestedStage) {
  const target = normalizeStage(requestedStage);
  const allowed = {
    CONCEPT: ["REQUEST"],
    ENGLISH: ["CONCEPT"],
    STORYBOARD: ["ENGLISH", "CONCEPT"],
    PACKAGE: ["STORYBOARD", "ENGLISH", "CONCEPT"],
    ASSETS: ["PACKAGE", "STORYBOARD", "ENGLISH", "CONCEPT"],
    RENDER: ["ASSETS", "PACKAGE", "STORYBOARD", "ENGLISH", "CONCEPT"],
  }[state.currentStage] ?? [];
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
  state.currentStage = target;
  state.status = "in_progress";
  record(state, "draft-rolled-back", {to: target});
  await writeDraftState(factoryRoot, state);
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
    requireNonEmptyArray(value.scenes, "scenes");
    for (const [index, scene] of value.scenes.entries()) {
      if (scene.scene !== index + 1) throw new Error("Storyboard scenes must be sequential.");
      requireStrings(scene, ["imageDescription", "action", "environment"]);
      requireNonEmptyArray(scene.sentences, `scenes[${index}].sentences`);
    }
  } else if (stage === "PACKAGE") {
    for (const approval of ["concept", "english", "scenes"]) {
      if (state.approvals[approval]?.approved !== true) {
        throw new Error(`PACKAGE requires approved ${approval}.`);
      }
    }
    validateProductionPackage(value, {
      draftId: state.draftId,
      series: state.series,
      subtype: state.subtype,
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

function record(state, event, detail = {}) {
  state.history ??= [];
  state.history.push({at: new Date().toISOString(), event, ...detail});
}
