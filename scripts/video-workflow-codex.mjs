import {mkdir, readFile, readdir, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
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
import {evaluateEpisodeGates} from "../src/gates.mjs";
import {buildStagePrompt} from "../src/stage-prompt.mjs";
import {
  createWorkflow,
  listWorkflows,
  readWorkflow,
  recordEvent,
  refreshEpisodeWorkflow,
  writeWorkflow,
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

async function approve([id, target]) {
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
      const finalPath = path.join(factoryRoot, "output", id, `${id}-final-v1.mp4`);
      try {
        await readFile(finalPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error(`Cannot approve final-assembly before ${relative(finalPath)} exists.`);
        }
        throw error;
      }
      state.approvals.finalAssembly = {
        approved: true,
        approvedAt: new Date().toISOString(),
      };
      state.status = "completed";
      state.updatedAt = new Date().toISOString();
      state.history ??= [];
      state.history.push({at: state.updatedAt, event: "final-assembly-approved"});
      await writeDraftState(factoryRoot, state);
      await writeCurrentTask(state);
      console.log(`Approved ${target} for ${id}.`);
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
    workflow.approvals.finalQa = true;
    recordEvent(workflow, "final-assembly-approved");
    await refreshEpisodeWorkflow(factoryRoot, workflow);
    console.log(`Approved ${target} for ${id}.`);
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
    const drafts = (await listDraftStates()).filter(
      (state) => state.status !== "completed",
    );
    const episodes = (await listWorkflows(factoryRoot)).filter(
      (workflow) =>
        workflow.kind === "episode" && workflow.status !== "completed",
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
  if (confirmation !== "--published") {
    throw new Error(
      "Archive requires explicit publication confirmation: archive <ID> --published",
    );
  }
  const workflow = await requireEpisode(id);
  await refreshEpisodeWorkflow(factoryRoot, workflow);
  if (
    workflow.status !== "completed" ||
    workflow.approvals.qa !== true
  ) {
    throw new Error("Only a completed, QA-approved episode can be archived.");
  }
  const archiveRoot = path.join(factoryRoot, "archive", "episodes", id);
  const targets = [
    ["inbox", path.join(factoryRoot, "inbox", id)],
    ["project", path.join(factoryRoot, "projects", id)],
    ["output", path.join(factoryRoot, "output", id)],
  ];
  await mkdir(archiveRoot, {recursive: true});
  workflow.currentStage = "archived";
  workflow.status = "archived";
  workflow.archivedAt = new Date().toISOString();
  workflow.nextAction = "Archived after publication confirmation.";
  recordEvent(workflow, "episode-archived", {reason: "published"});
  await writeWorkflow(factoryRoot, workflow);
  for (const [name, source] of targets) {
    if (await exists(source)) {
      await rename(source, path.join(archiveRoot, name));
    }
  }
  await writeJson(path.join(archiveRoot, "archive.json"), {
    episode: id,
    archivedAt: workflow.archivedAt,
    reason: "published",
    locations: {
      inbox: "inbox/",
      project: "project/",
      output: "output/",
    },
  });
  console.log(`Archived published episode ${id} to ${relative(archiveRoot)}.`);
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

async function exists(value) {
  try {
    await readFile(path.join(value, "workflow.json"));
    return true;
  } catch {
    try {
      await readdir(value);
      return true;
    } catch {
      return false;
    }
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
