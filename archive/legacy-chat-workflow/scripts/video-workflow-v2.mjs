import {spawnSync} from "node:child_process";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  approveDraftStage,
  createDraftState,
  draftRoot,
  readDraftState,
  rollbackDraft,
  submitStageArtifact,
  writeDraftState,
  writeRequest,
} from "../src/draft-workflow.mjs";
import {buildStagePrompt} from "../src/stage-prompt.mjs";

const factoryRoot = process.cwd();
const [command = "start", ...args] = process.argv.slice(2);

try {
  if (command === "start" && args[0] === "LLFC") await startDraft(args);
  else if (command === "request") await completeRequest(args);
  else if (command === "submit") await submit(args);
  else if (command === "approve" && (await isStagedDraft(args[0]))) {
    await approve(args);
  } else if (command === "rollback") await rollback(args);
  else if (command === "handoff" && (await isStagedDraft(args[0]))) {
    await handoff(args[0]);
  } else if (
    ["status", "continue"].includes(command) &&
    args[0] &&
    (await isStagedDraft(args[0]))
  ) {
    await showDraft(args[0], command === "continue");
  } else {
    runLegacy();
  }
} catch (error) {
  console.error(`Workflow error: ${error.message}`);
  process.exitCode = 1;
}

async function startDraft(args) {
  const [series, maybeSubtype] = args;
  const subtype = maybeSubtype?.startsWith("--") ? "default" : maybeSubtype ?? "default";
  const sourceConcept = option(args, "--source");
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
    const requestPath = path.join(draftRoot(factoryRoot, draftId), "request.yaml");
    await writeFile(
      requestPath,
      `${JSON.stringify({draftId, series, subtype, format: series, sourceConcept: null}, null, 2)}\n`,
      "utf8",
    );
  }
  await writePrompt(state);
  console.log(`Created ${draftId}: ${series} / ${subtype}`);
  printState(state);
  console.log(`Prompt: ${relative(path.join(draftRoot(factoryRoot, draftId), "handoff", "chat-prompt.txt"))}`);
}

async function completeRequest([id, ...args]) {
  const state = await requireState(id);
  const sourceConcept = option(args, "--source") ?? args.join(" ").trim();
  if (!sourceConcept) {
    throw new Error("Usage: pnpm video:workflow request <DRAFT-ID> --source \"Movie\"");
  }
  await writeRequest(factoryRoot, state, {
    draftId: state.draftId,
    series: state.series,
    subtype: state.subtype,
    format: state.format,
    sourceConcept,
  });
  await writePrompt(state);
  printState(state);
}

async function submit([id, stage, fileArgument]) {
  if (!fileArgument) {
    throw new Error("Usage: pnpm video:workflow submit <DRAFT-ID> <STAGE> <FILE>");
  }
  const state = await requireState(id);
  const sourcePath = path.resolve(factoryRoot, fileArgument);
  const value = JSON.parse(await readFile(sourcePath, "utf8"));
  const artifactPath = await submitStageArtifact(factoryRoot, state, stage, value);
  await writePrompt(state);
  console.log(`Validated and saved ${relative(artifactPath)}.`);
  console.log(`Next: pnpm video:workflow approve ${id} ${approvalName(stage)}`);
}

async function approve([id, target]) {
  const state = await requireState(id);
  await approveDraftStage(factoryRoot, state, target);
  await writePrompt(state);
  console.log(`Approved ${target} for ${id}.`);
  printState(state);
  if (state.currentStage === "ASSETS") {
    console.log("The package is ready for the existing asset pipeline.");
  }
}

async function rollback([id, stage]) {
  const state = await requireState(id);
  await rollbackDraft(factoryRoot, state, stage);
  await writePrompt(state);
  printState(state);
}

async function handoff(id) {
  const state = await requireState(id);
  const promptPath = await writePrompt(state);
  console.log(await readFile(promptPath, "utf8"));
}

async function showDraft(id, includePrompt) {
  const state = await requireState(id);
  printState(state);
  if (includePrompt) {
    console.log(`\n${await readFile(await writePrompt(state), "utf8")}`);
  }
}

async function writePrompt(state) {
  const promptPath = path.join(draftRoot(factoryRoot, state.draftId), "handoff", "chat-prompt.txt");
  await mkdir(path.dirname(promptPath), {recursive: true});
  await writeFile(promptPath, `${buildStagePrompt(state)}\n`, "utf8");
  return promptPath;
}

async function isStagedDraft(id) {
  return Boolean(id?.startsWith("DRAFT-") && (await readDraftState(factoryRoot, id)));
}

async function requireState(id) {
  if (!id) throw new Error("A draft ID is required.");
  const state = await readDraftState(factoryRoot, id);
  if (!state) throw new Error(`Staged draft not found: ${id}`);
  return state;
}

async function nextDraftId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const root = path.join(factoryRoot, "projects", "_drafts");
  const existing = await readDirectories(root);
  let sequence = 1;
  while (existing.includes(`DRAFT-${date}-${String(sequence).padStart(3, "0")}`)) {
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

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function approvalName(stage) {
  return {CONCEPT: "concept", ENGLISH: "english", STORYBOARD: "scenes", PACKAGE: "package"}[
    String(stage).toUpperCase()
  ];
}

function printState(state) {
  console.log(
    `- ${state.draftId} | ${state.series}/${state.subtype} | ${state.currentStage} | ${state.status}`,
  );
}

function relative(value) {
  return path.relative(factoryRoot, value).replaceAll(path.sep, "/");
}

function runLegacy() {
  console.warn("Note: this command uses the deprecated legacy workflow compatibility path.");
  const result = spawnSync(process.execPath, ["scripts/video-workflow.mjs", command, ...args], {
    cwd: factoryRoot,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}
