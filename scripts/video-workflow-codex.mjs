import {mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {createReadStream} from "node:fs";
import path from "node:path";
import process from "node:process";
import {createHash} from "node:crypto";
import {
  getCategory,
  loadCategoryRegistry,
  validateEpisodeForCategory,
} from "../src/categories.mjs";
import {
  approveDraftStage,
  createDraftState,
  draftBlocksProductionWorkflow,
  draftRoot,
  readDraftState,
  recordPrepareComplete,
  rollbackDraft,
  submitStageArtifact,
  writeDraftState,
  writeRequest,
} from "../src/draft-workflow.mjs";
import {
  archiveEpisodeRecord,
  TERMINAL_DRAFT_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from "../src/episode-archive.mjs";
import {evaluateEpisodeGates} from "../src/gates.mjs";
import {buildStagePrompt} from "../src/stage-prompt.mjs";
import {
  createWorkflow,
  listWorkflows,
  readWorkflow,
  recordEvent,
  refreshEpisodeWorkflow,
} from "../src/workflow.mjs";

const factoryRoot = process.cwd();
const registry = await loadCategoryRegistry(factoryRoot);
const [command = "start", ...args] = process.argv.slice(2);

try {
  if (command === "start") await start(args);
  else if (command === "request") await completeRequest(args);
  else if (command === "submit") await submit(args);
  else if (command === "approve") await approve(args);
  else if (command === "prepare") await prepareDraft(args);
  else if (command === "rollback") await rollback(args);
  else if (command === "discover") await discover();
  else if (command === "status") await status(args[0]);
  else if (command === "continue") await continueWorkflow(args[0]);
  else if (command === "reject") await reject(args);
  else if (command === "archive") await archiveEpisode(args);
  else if (command === "categories") printCategories();
  else throw new Error(`Unknown workflow command "${command}".`);
} catch (error) {
  console.error(`Workflow error: ${error.message}`);
  process.exitCode = 1;
}

async function start([series, maybeSubtype, ...rest]) {
  if (!series) {
    await status();
    console.log('\nStart with Codex: "開始一支新的 LLFC 影片，電影是 …"');
    return;
  }
  if (series !== "LLFC") {
    throw new Error(
      "New creative drafts currently support LLFC. Existing inbox episodes use discover.",
    );
  }
  const subtype = maybeSubtype?.startsWith("--") ? "default" : maybeSubtype ?? "default";
  getCategory(registry, series, subtype);
  const optionArgs = maybeSubtype?.startsWith("--")
    ? [maybeSubtype, ...rest]
    : rest;
  const sourceConcept = option(optionArgs, "--source");
  const draftId = await nextDraftId();
  const state = createDraftState({
    draftId,
    series,
    subtype,
    format: series,
    requestComplete: Boolean(sourceConcept),
  });
  await writeDraftState(factoryRoot, state);
  if (sourceConcept) {
    await writeRequest(factoryRoot, state, {
      draftId,
      series,
      subtype,
      format: series,
      sourceConcept,
    });
  } else {
    await writeJson(path.join(draftRoot(factoryRoot, draftId), "request.yaml"), {
      draftId,
      series,
      subtype,
      format: series,
      sourceConcept: null,
    });
  }
  await writeCurrentTask(state);
  console.log(`Created ${draftId}: ${series} / ${subtype}`);
  printDraft(state);
  console.log("Codex will complete only the current stage and ask for one approval.");
}

async function completeRequest([id, ...requestArgs]) {
  const state = await requireDraft(id);
  const sourceConcept =
    option(requestArgs, "--source") ?? requestArgs.join(" ").trim();
  if (!sourceConcept) {
    throw new Error("Request requires a movie or source concept.");
  }
  await writeRequest(factoryRoot, state, {
    draftId: state.draftId,
    series: state.series,
    subtype: state.subtype,
    format: state.format,
    sourceConcept,
  });
  await writeCurrentTask(state);
  printDraft(state);
}

async function submit([id, stage, fileArgument]) {
  if (!fileArgument) {
    throw new Error("Codex submit requires <DRAFT-ID> <STAGE> <FILE>.");
  }
  const state = await requireDraft(id);
  const sourcePath = path.resolve(factoryRoot, fileArgument);
  const value = JSON.parse(await readFile(sourcePath, "utf8"));
  const artifactPath = await submitStageArtifact(
    factoryRoot,
    state,
    stage,
    value,
  );
  await writeCurrentTask(state);
  if (String(stage).toUpperCase() === "ASSETS") {
    console.log(`Validated ASSETS completion for ${id}; advanced to RENDER.`);
  } else {
    console.log(`Validated and saved ${relative(artifactPath)}.`);
    console.log(`Waiting for user approval: ${approvalName(stage)}.`);
  }
}

async function approve([id, target, ...rest]) {
  const artifactPath = option(rest, "--artifact");
  const state = await readDraftState(factoryRoot, id);
  if (state) {
    // Draft-backed ESSY episodes remain governed by state.yaml through the
    // render review.  QA is an episode gate (not one of the four creative
    // artifact approvals), so route it here rather than rejecting the
    // canonical `approve <EP> qa` command merely because a draft exists.
    if (target === "qa") {
      state.approvals.qa = {
        approved: true,
        approvedAt: new Date().toISOString(),
      };
      state.status = "final_assembly_pending";
      state.updatedAt = new Date().toISOString();
      state.history ??= [];
      state.history.push({at: state.updatedAt, event: "qa-approved"});
      await writeDraftState(factoryRoot, state);
      await writeCurrentTask(state);
      console.log(`Approved ${target} for ${id}.`);
      printDraft(state);
      return;
    }
    // Draft-backed ESSY stays owned by state.yaml through FINALIZE. Gate 4 is
    // a final-output approval, not a creative-artifact approval, so it must
    // not be routed through approveDraftStage(). Require both Gate 3 and a
    // rendered final master before completing the draft.
    if (target === "final-assembly") {
      if (state.approvals.qa?.approved !== true) {
        throw new Error("Cannot approve final-assembly before QA approval.");
      }
      const artifactMeta = await resolveArtifactForApproval(factoryRoot, id, artifactPath);
      const approvedAt = new Date().toISOString();
      state.approvals.finalAssembly = {
        approved: true,
        approvedAt,
        artifact: artifactMeta,
      };
      state.status = "completed";
      state.updatedAt = approvedAt;
      state.history ??= [];
      state.history.push({at: approvedAt, event: "final-assembly-approved", artifact: artifactMeta});
      await writeDraftState(factoryRoot, state);
      await writeCurrentTask(state);
      console.log(`Approved ${target} for ${id} (artifact: ${artifactMeta.filename}).`);
      printDraft(state);
      return;
    }
    // PREPARE has no human approval gate (Runbook: PREPARE hands timing to
    // DIRECT). Record deterministic machine completion via `prepare` instead.
    if (target === "prepare") {
      throw new Error(
        `PREPARE is not a human approval. Record machine completion with "pnpm video:workflow prepare ${id}".`,
      );
    }
    await approveDraftStage(factoryRoot, state, target);
    await writeCurrentTask(state);
    console.log(`Approved ${target} for ${id}.`);
    printDraft(state);
    return;
  }
  const workflow = await requireEpisode(id);
  if (!["content", "images", "qa", "final-assembly"].includes(target)) {
    throw new Error(
      "Episode approval target must be content, images, qa, or final-assembly.",
    );
  }
  if (target === "final-assembly") {
    const artifactMeta = await resolveArtifactForApproval(factoryRoot, id, artifactPath);
    const approvedAt = new Date().toISOString();
    workflow.approvals.finalQa = true;
    workflow.approvals.finalAssemblyArtifact = {...artifactMeta, approvedAt};
    recordEvent(workflow, "final-assembly-approved", {artifact: artifactMeta});
    await refreshEpisodeWorkflow(factoryRoot, workflow);
    console.log(`Approved ${target} for ${id} (artifact: ${artifactMeta.filename}).`);
    printEpisode(workflow);
    return;
  }
  workflow.approvals[target] = true;
  if (target === "qa") {
    workflow.needsRerender = false;
    workflow.rerenderReason = null;
  }
recordEvent(workflow, `${target}-approved`);
  await refreshEpisodeWorkflow(factoryRoot, workflow);
  console.log(`Approved ${target} for ${id}.`);
  printEpisode(workflow);
}

// --- Artifact resolution & validation for final-assembly approval ---

/**
 * Resolve and validate the artifact for final-assembly approval.
 * The artifact file is authoritative for identity (path, filename, size, sha256).
 * final-assembly-qa.json may enrich with durationSec, subtitleQaPassed, renderLabel.
 * Security: rejects absolute paths, directory traversal, paths outside output/<EP>/.
 */
async function resolveArtifactForApproval(factoryRoot, episode, artifactPathArg) {
  // 1) Resolve artifact path from argument (mandatory for new approvals)
  let artifactPath;
  if (artifactPathArg) {
    artifactPath = path.resolve(factoryRoot, artifactPathArg);
  } else {
    // Legacy fallback: try to find final-assembly-qa.json and use its output
    const qaPath = path.join(factoryRoot, "projects", episode, "temp", "final-assembly", "final-assembly-qa.json");
    let qaOutput = null;
    try {
      const qa = JSON.parse(await readFile(qaPath, "utf8"));
      qaOutput = qa.output;
    } catch {
      // ignore, will fall through to error
    }
    if (qaOutput) {
      artifactPath = path.resolve(factoryRoot, qaOutput);
      console.warn(`Warning: --artifact not provided; using QA record output: ${path.relative(factoryRoot, artifactPath)}`);
    } else {
      throw new Error(
        `Cannot approve final-assembly: --artifact <path> is required. ` +
        `Usage: pnpm video:workflow approve ${episode} final-assembly --artifact output/${episode}/${episode}-final-v2.mp4`
      );
    }
  }

  // 2) Security validation: must be under output/<episode>/
  const expectedRoot = path.resolve(factoryRoot, "output", episode);
  const normalizedArtifact = path.normalize(artifactPath);
  const normalizedExpected = path.normalize(expectedRoot);
  if (!normalizedArtifact.startsWith(normalizedExpected + path.sep) && normalizedArtifact !== normalizedExpected) {
    throw new Error(
      `Artifact path must be inside output/${episode}/. ` +
      `Got: ${path.relative(factoryRoot, artifactPath)}`
    );
  }
  // Reject absolute paths in argument (must be relative to repo root)
  if (path.isAbsolute(artifactPathArg)) {
    throw new Error(`Artifact path must be relative to repository root, not absolute.`);
  }
  // Reject directory traversal attempts
  if (artifactPathArg?.includes("..")) {
    throw new Error(`Artifact path must not contain directory traversal (..).`);
  }

  // 3) Verify artifact file exists and is a file
  let statInfo;
  try {
    statInfo = await stat(artifactPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Artifact file does not exist: ${path.relative(factoryRoot, artifactPath)}`);
    }
    throw error;
  }
  if (!statInfo.isFile()) {
    throw new Error(`Artifact path is not a file: ${path.relative(factoryRoot, artifactPath)}`);
  }

  // 4) Compute SHA-256 from the actual artifact file (authoritative)
  const sha256 = await computeFileSha256(artifactPath);

  // 5) Load QA metadata for enrichment (non-authoritative for identity)
  let qaMeta = {
    durationSec: null,
    subtitleQaPassed: null,
    renderLabel: extractRenderLabel(null, path.basename(artifactPath)),
  };
  const qaPath = path.join(factoryRoot, "projects", episode, "temp", "final-assembly", "final-assembly-qa.json");
  try {
    const qa = JSON.parse(await readFile(qaPath, "utf8"));
    // QA output must match the artifact we're approving (mismatch detection)
    if (qa.output) {
      const qaOutputPath = path.resolve(factoryRoot, qa.output);
      if (qaOutputPath !== artifactPath) {
        throw new Error(
          `QA record output (${qa.output}) does not match the artifact being approved ` +
          `(${path.relative(factoryRoot, artifactPath)}). Refusing to associate QA from another render.`
        );
      }
    }
    // Enrich from QA (non-authoritative fields)
    qaMeta = {
      durationSec: qa.durationSec ?? null,
      subtitleQaPassed: qa.subtitleQa?.passed ?? null,
      renderLabel: extractRenderLabel(qa, path.basename(artifactPath)),
    };
  } catch (error) {
    if (error?.message?.includes("does not match")) throw error;
    // QA file missing or invalid - proceed with file-only metadata (qaMeta already has renderLabel from filename)
  }

  // 6) Build artifact metadata object (artifact file is authoritative)
  const filename = path.basename(artifactPath);
  const relativePath = path.relative(factoryRoot, artifactPath).replaceAll(path.sep, "/");

  return {
    filename,
    path: relativePath,
    sha256,
    sizeBytes: statInfo.size,
    ...qaMeta,
  };
}

/**
 * Compute SHA-256 hash of a file using streaming (memory efficient).
 */
function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Extract render label from QA record or filename.
 * Prefers QA subtitleBurn.mode, falls back to filename pattern.
 */
function extractRenderLabel(qa, filename) {
  if (qa?.subtitleBurn?.mode) {
    return qa.subtitleBurn.mode;
  }
  // Try to extract from filename like ESSY-0004-final-v2.mp4 -> final-v2
  const match = filename.match(/final-(v\d+)\.mp4$/i);
  if (match) return `final-${match[1]}`;
  return "final";
}

async function rollback([id, stage]) {
  const state = await requireDraft(id);
  await rollbackDraft(factoryRoot, state, stage);
  await writeCurrentTask(state);
  printDraft(state);
}

// Deterministic PREPARE machine completion (ESSY-only, no human approval).
// Validates actual TTS timing, then advances PREPARE -> STORYBOARD (= DIRECT)
// and records an explicit prepare-complete history event.
async function prepareDraft([id]) {
  const state = await requireDraft(id);
  await recordPrepareComplete(factoryRoot, state);
  await writeCurrentTask(state);
  console.log(`Recorded PREPARE completion for ${id}.`);
  printDraft(state);
}

async function discover() {
  const names = await readDirectories(path.join(factoryRoot, "inbox"));
  let created = 0;
  for (const episode of names) {
    // A draft-backed episode keeps state.yaml authoritative through review,
    // so discover() must never create a competing production workflow.json
    // for it during WRITE/PREPARE/DIRECT (or any later draft stage).
    const draft = await readDraftState(factoryRoot, episode);
    if (draft && draftBlocksProductionWorkflow(draft)) {
      continue;
    }
    const inferred = inferCategory(episode);
    if (!inferred) continue;
    validateEpisodeForCategory(registry, episode, inferred.series);
    let workflow = await readWorkflow(factoryRoot, episode);
    if (!workflow) {
      workflow = createWorkflow({
        id: episode,
        kind: "episode",
        ...inferred,
        currentStage: "creative-development",
        status: "waiting",
      });
      const gates = await evaluateEpisodeGates({
        factoryRoot,
        episode,
        ...inferred,
      });
      if (gates.lesson.passed) {
        workflow.approvals.content = true;
        workflow.approvals.images = gates.images.passed;
        recordEvent(workflow, "existing-input-adopted", {
          reason: "Existing renderer input was already approved.",
        });
      }
      created += 1;
    }
    await refreshEpisodeWorkflow(factoryRoot, workflow);
  }
  console.log(`Discovery complete. Created ${created} workflow(s).`);
  await status();
}

async function status(id) {
  if (id) {
    const state = await readDraftState(factoryRoot, id);
    if (state) {
      printDraft(state);
      return;
    }
    const workflow = await requireEpisode(id);
    await refreshEpisodeWorkflow(factoryRoot, workflow);
    printEpisode(workflow);
    return;
  }
  const drafts = await listDraftStates();
  const episodes = (await listWorkflows(factoryRoot)).filter(
    (workflow) => workflow.kind === "episode",
  );
  if (drafts.length === 0 && episodes.length === 0) {
    console.log("No active workflows.");
    return;
  }
  for (const state of drafts) printDraft(state);
  for (const workflow of episodes) printEpisode(workflow);
}

async function continueWorkflow(id) {
  if (!id) {
    // Archived records are terminal, exactly like completed ones: `continue`
    // must never offer an archived episode as unfinished work.
    const drafts = (await listDraftStates()).filter(
      (state) => !TERMINAL_DRAFT_STATUSES.includes(String(state.status)),
    );
    const episodes = (await listWorkflows(factoryRoot)).filter(
      (workflow) =>
        workflow.kind === "episode" &&
        !TERMINAL_WORKFLOW_STATUSES.includes(String(workflow.status)),
    );
    const active = [...drafts, ...episodes];
    if (active.length !== 1) {
      if (active.length === 0) console.log("No unfinished workflow.");
      else {
        console.log("Choose one unfinished workflow:");
        for (const item of active) {
          if (item.draftId) printDraft(item);
          else printEpisode(item);
        }
      }
      return;
    }
    id = active[0].draftId ?? active[0].id;
  }
  const state = await readDraftState(factoryRoot, id);
  if (state) {
    printDraft(state);
    console.log(`\n${await readFile(await writeCurrentTask(state), "utf8")}`);
    return;
  }
  const workflow = await requireEpisode(id);
  await refreshEpisodeWorkflow(factoryRoot, workflow);
  printEpisode(workflow);
}

async function reject([id, target, ...reasonArgs]) {
  if (target !== "qa") throw new Error("Only QA rejection is supported.");
  const reasonIndex = reasonArgs.indexOf("--reason");
  const reason =
    reasonIndex >= 0
      ? reasonArgs.slice(reasonIndex + 1).join(" ").trim()
      : reasonArgs.join(" ").trim();
  if (!reason) throw new Error("QA rejection requires a reason.");
  const workflow = await requireEpisode(id);
  workflow.approvals.qa = false;
  workflow.needsRerender = true;
  workflow.rerenderReason = reason;
  recordEvent(workflow, "qa-rejected", {reason});
  await refreshEpisodeWorkflow(factoryRoot, workflow);
  printEpisode(workflow);
}

async function archiveEpisode([id, confirmation]) {
  const result = await archiveEpisodeRecord({
    factoryRoot,
    episode: id,
    confirmation,
  });
  console.log(`Archived published episode ${id} to ${relative(result.archiveRoot)}.`);
  console.log(
    `  Authoritative ${result.kind} record: ${result.source} (archived at ${result.archivedAt}).`,
  );
}

async function writeCurrentTask(state) {
  const taskPath = path.join(
    draftRoot(factoryRoot, state.draftId),
    "runtime",
    "current-stage.txt",
  );
  await mkdir(path.dirname(taskPath), {recursive: true});
  await writeFile(taskPath, `${buildStagePrompt(state)}\n`, "utf8");
  return taskPath;
}

async function listDraftStates() {
  const result = [];
  for (const id of await readDirectories(
    path.join(factoryRoot, "projects", "_drafts"),
  )) {
    const state = await readDraftState(factoryRoot, id);
    if (state) result.push(state);
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function requireDraft(id) {
  if (!id) throw new Error("A draft ID is required.");
  const state = await readDraftState(factoryRoot, id);
  if (!state) throw new Error(`Draft not found: ${id}`);
  return state;
}

async function requireEpisode(id) {
  if (!id) throw new Error("An episode ID is required.");
  const workflow = await readWorkflow(factoryRoot, id);
  if (!workflow || workflow.kind !== "episode") {
    throw new Error(`Episode workflow not found: ${id}`);
  }
  return workflow;
}

async function nextDraftId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const existing = await readDirectories(
    path.join(factoryRoot, "projects", "_drafts"),
  );
  let sequence = 1;
  while (
    existing.includes(`DRAFT-${date}-${String(sequence).padStart(3, "0")}`)
  ) {
    sequence += 1;
  }
  return `DRAFT-${date}-${String(sequence).padStart(3, "0")}`;
}

async function readDirectories(directory) {
  try {
    return (await readdir(directory, {withFileTypes: true}))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function inferCategory(episode) {
  // Registry-driven lookup so newly registered series (e.g. ESSY) work in
  // discover/status without touching this file again.
  for (const [series, entry] of Object.entries(registry.series)) {
    if (!new RegExp(entry.episodePattern).test(episode)) continue;
    const subtypes = Object.keys(entry.subtypes ?? {});
    const subtype = subtypes.includes("default")
      ? "default"
      : subtypes[0] ?? "default";
    return {series, subtype};
  }
  return null;
}

function option(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : null;
}

function approvalName(stage) {
  return {
    CONCEPT: "concept",
    ENGLISH: "english",
    STORYBOARD: "scenes",
    PACKAGE: "package",
  }[String(stage).toUpperCase()];
}

function printDraft(state) {
  console.log(
    `- ${state.draftId} | ${state.series}/${state.subtype} | ${state.currentStage} | ${state.status}`,
  );
  if (state.status === "archived") {
    console.log(
      `  Archived after publication confirmation (${state.archivedAt ?? "date unrecorded"}). Restore from archive/episodes/${state.draftId}/ before any further work.`,
    );
    return;
  }
  if (
    state.currentStage === "PREPARE" &&
    String(state.series ?? "").toUpperCase() === "ESSY"
  ) {
    const prepared = state.prepare?.completed === true;
    if (prepared) {
      console.log(
        `  PREPARE complete (${state.prepare.blockCount ?? "?"} blocks, ${state.prepare.totalDurationSec ?? "?"}s). Next: DIRECT storyboard planning.`,
      );
    } else {
      console.log(
        "  Codex action: complete PREPARE (TTS + WordBoundary timing), then run: pnpm video:workflow prepare <ID>",
      );
    }
    return;
  }
  const approval = {
    CONCEPT: "concept",
    ENGLISH: "english",
    STORYBOARD: "scenes",
    PACKAGE: "package",
  }[state.currentStage];
  if (state.status === "needs_approval" && approval) {
    console.log(`  Waiting for user approval: ${approval}`);
  } else {
    console.log(`  Codex action: complete ${state.currentStage}`);
  }
}

function printEpisode(workflow) {
  console.log(
    `- ${workflow.id} | ${workflow.series}/${workflow.subtype} | ${workflow.currentStage} | ${workflow.status}`,
  );
  if (workflow.nextAction) console.log(`  Next: ${workflow.nextAction}`);
}

function printCategories() {
  for (const [series, seriesValue] of Object.entries(registry.series)) {
    for (const [subtype, value] of Object.entries(seriesValue.subtypes)) {
      console.log(`- ${series} / ${subtype}: ${value.label}`);
    }
  }
}

function relative(value) {
  return path.relative(factoryRoot, value).replaceAll(path.sep, "/");
}

// Export for testing
export {resolveArtifactForApproval, computeFileSha256, extractRenderLabel};
