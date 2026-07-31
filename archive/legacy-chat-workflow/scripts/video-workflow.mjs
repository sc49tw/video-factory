import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  getCategory,
  loadCategoryRegistry,
  nextEpisodeId,
  validateEpisodeForCategory,
} from "../src/categories.mjs";
import {buildChatPrompt, validateChatPackage} from "../src/chat-handoff.mjs";
import {evaluateEpisodeGates} from "../src/gates.mjs";
import {
  createWorkflow,
  listWorkflows,
  readWorkflow,
  recordEvent,
  refreshEpisodeWorkflow,
  resolveWorkflowPath,
  writeWorkflow,
} from "../src/workflow.mjs";

const factoryRoot = process.cwd();
const [command = "start", ...args] = process.argv.slice(2);
const registry = await loadCategoryRegistry(factoryRoot);

try {
  if (command === "start") await start(args);
  else if (command === "discover") await discover();
  else if (command === "status") await status(args[0]);
  else if (command === "continue") await continueWorkflow(args[0]);
  else if (command === "handoff") await handoff(args[0]);
  else if (command === "import-chat") await importChat(args[0], args[1]);
  else if (command === "approve") await approve(args[0], args[1]);
  else if (command === "reject") await reject(args);
  else if (command === "categories") printCategories();
  else throw new Error(`Unknown workflow command "${command}".`);
} catch (error) {
  console.error(`Workflow error: ${error.message}`);
  process.exitCode = 1;
}

async function start([series, subtype]) {
  const active = (await listWorkflows(factoryRoot)).filter(
    (workflow) => !["completed", "promoted"].includes(workflow.status),
  );
  if (!series) {
    if (active.length > 0) {
      console.log("Unfinished productions:");
      for (const workflow of active) printWorkflowLine(workflow);
      console.log("\nContinue one with: pnpm video:workflow continue <ID>");
    } else {
      console.log("No unfinished production was found.");
    }
    console.log("\nAvailable video types:");
    printCategories();
    console.log("\nStart a new draft with: pnpm video:workflow start <SERIES> <SUBTYPE>");
    return;
  }

  const selectedSubtype =
    subtype ??
    (Object.keys(registry.series?.[series]?.subtypes ?? {}).length === 1
      ? Object.keys(registry.series[series].subtypes)[0]
      : null);
  if (!selectedSubtype) {
    throw new Error(`Choose a subtype for ${series}.`);
  }
  const category = getCategory(registry, series, selectedSubtype).subtype;
  const draftId = await nextDraftId();
  const workflow = createWorkflow({
    id: draftId,
    kind: "draft",
    series,
    subtype: selectedSubtype,
    currentStage: "creative-development",
    status: "waiting-for-chat",
  });
  workflow.nextAction = "Take the generated prompt to Chat and return its final JSON package.";
  recordEvent(workflow, "draft-created");
  const workflowPath = await writeWorkflow(factoryRoot, workflow);
  const prompt = buildChatPrompt({
    draftId,
    series,
    subtype: selectedSubtype,
    category,
  });
  const handoffRoot = path.join(path.dirname(workflowPath), "handoff");
  await mkdir(handoffRoot, {recursive: true});
  const promptPath = path.join(handoffRoot, "chat-prompt.txt");
  await writeFile(promptPath, `${prompt}\n`, "utf8");
  console.log(`Created ${draftId}: ${series} / ${selectedSubtype}`);
  console.log(`Chat prompt: ${relative(promptPath)}`);
  console.log("\n--- CHAT PROMPT ---\n");
  console.log(prompt);
}

async function discover() {
  const inboxRoot = path.join(factoryRoot, "inbox");
  const names = await readDirectories(inboxRoot);
  let created = 0;
  for (const episode of names) {
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
          reason: "Existing lesson and assets are treated as previously approved production input.",
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
    const workflow = await requireWorkflow(id);
    if (workflow.kind === "episode") await refreshEpisodeWorkflow(factoryRoot, workflow);
    printWorkflowDetail(workflow);
    return;
  }
  const workflows = await listWorkflows(factoryRoot);
  if (workflows.length === 0) {
    console.log("No workflows. Run pnpm video:workflow discover or start.");
    return;
  }
  for (const workflow of workflows) printWorkflowLine(workflow);
}

async function continueWorkflow(id) {
  if (!id) {
    const active = (await listWorkflows(factoryRoot)).filter(
      (workflow) => !["completed", "promoted"].includes(workflow.status),
    );
    if (active.length === 0) {
      console.log("No unfinished workflow. Start one with pnpm video:workflow start.");
      return;
    }
    if (active.length > 1) {
      console.log("Choose one unfinished production:");
      for (const workflow of active) printWorkflowLine(workflow);
      return;
    }
    id = active[0].id;
  }
  const workflow = await requireWorkflow(id);
  if (workflow.kind === "episode") await refreshEpisodeWorkflow(factoryRoot, workflow);
  printWorkflowDetail(workflow);
  if (
    workflow.status === "waiting-for-chat" ||
    workflow.currentStage === "creative-development"
  ) {
    console.log(`\nShow the Chat prompt with: pnpm video:workflow handoff ${workflow.id}`);
  }
}

async function handoff(id) {
  const workflow = await requireWorkflow(id);
  const category = getCategory(
    registry,
    workflow.series,
    workflow.subtype,
  ).subtype;
  const promptPath = await ensureHandoffPrompt(workflow, category);
  console.log(await readFile(promptPath, "utf8"));
}

async function importChat(id, fileArgument) {
  if (!fileArgument) {
    throw new Error("Usage: pnpm video:workflow import-chat <DRAFT-ID> <JSON-FILE>");
  }
  const workflow = await requireWorkflow(id);
  const sourcePath = path.resolve(factoryRoot, fileArgument);
  const packageValue = JSON.parse(await readFile(sourcePath, "utf8"));
  validateChatPackage(packageValue, {
    draftId: id,
    series: workflow.series,
    subtype: workflow.subtype,
  });
  const workflowRoot = path.dirname(resolveWorkflowPath(factoryRoot, id));
  const packagePath = path.join(workflowRoot, "chat-package.json");
  await writeFile(packagePath, `${JSON.stringify(packageValue, null, 2)}\n`, "utf8");
  workflow.currentStage = "content-approval";
  workflow.status = "needs-approval";
  workflow.nextAction = "Review and explicitly approve the Chat package content.";
  workflow.chatPackage = relative(packagePath);
  recordEvent(workflow, "chat-package-imported", {source: relative(sourcePath)});
  await writeWorkflow(factoryRoot, workflow);
  console.log(`Imported and validated Chat package for ${id}.`);
  console.log(`Next: pnpm video:workflow approve ${id} content`);
}

async function approve(id, target) {
  if (!["content", "images", "qa"].includes(target)) {
    throw new Error("Approval target must be content, images, or qa.");
  }
  const workflow = await requireWorkflow(id);
  if (workflow.kind === "draft") {
    if (target !== "content") throw new Error("A draft can only approve content.");
    await promoteDraft(workflow);
    return;
  }
  if (target === "content") {
    await materializeEpisodeLessonFromChatPackage(workflow);
  }
  if (target === "content") workflow.approvals.content = true;
  if (target === "images") workflow.approvals.images = true;
  if (target === "qa") workflow.approvals.qa = true;
  recordEvent(workflow, `${target}-approved`);
  await refreshEpisodeWorkflow(factoryRoot, workflow);
  console.log(`Approved ${target} for ${id}.`);
  printWorkflowDetail(workflow);
}

async function reject(args) {
  const [id, target, ...rest] = args;
  if (target !== "qa") {
    throw new Error("Currently only QA rejection is supported.");
  }
  const reasonIndex = rest.indexOf("--reason");
  const reason =
    reasonIndex >= 0 ? rest.slice(reasonIndex + 1).join(" ").trim() : rest.join(" ").trim();
  if (!reason) {
    throw new Error(
      "QA rejection requires a reason: pnpm video:workflow reject <ID> qa --reason \"...\"",
    );
  }
  const workflow = await requireWorkflow(id);
  if (workflow.kind !== "episode") throw new Error("Only an episode can reject QA.");
  workflow.approvals.qa = false;
  workflow.needsRerender = true;
  workflow.rerenderReason = reason;
  recordEvent(workflow, "qa-rejected", {reason});
  await refreshEpisodeWorkflow(factoryRoot, workflow);
  console.log(`Rejected QA for ${id}.`);
  printWorkflowDetail(workflow);
}

async function promoteDraft(draft) {
  const draftRoot = path.dirname(resolveWorkflowPath(factoryRoot, draft.id));
  const packagePath = path.join(draftRoot, "chat-package.json");
  const packageValue = validateChatPackage(
    JSON.parse(await readFile(packagePath, "utf8")),
    {draftId: draft.id, series: draft.series, subtype: draft.subtype},
  );
  const episode = await nextEpisodeId(factoryRoot, registry, draft.series);
  const inboxRoot = path.join(factoryRoot, "inbox", episode);
  await mkdir(inboxRoot, {recursive: true});
  const lesson = {
    episode,
    series: draft.series,
    subtype: draft.subtype,
    title: packageValue.title,
    language: packageValue.language ?? "en",
    level: packageValue.level ?? "A2",
    renderMode: "double-pass-shadowing",
    countdownSeconds: 4,
    transitionSeconds: 0.4,
    tts: {provider: "edge", voice: "en-US-JennyNeural", rate: "+0%"},
    video: {width: 1920, height: 1080, fps: 30},
    scenes: packageValue.scenes.map((scene, index) => ({
      id: `scene${String(index + 1).padStart(2, "0")}`,
      image: `scene${String(index + 1).padStart(2, "0")}.png`,
      sentences: scene.sentences.map((text) => ({text})),
    })),
  };
  const lessonPath = path.join(inboxRoot, "lesson.json");
  await writeFile(lessonPath, `${JSON.stringify(lesson, null, 2)}\n`, "utf8");
  const episodeProjectRoot = path.join(factoryRoot, "projects", episode, "source");
  await mkdir(episodeProjectRoot, {recursive: true});
  const creativePath = path.join(episodeProjectRoot, "creative-package.json");
  await writeFile(creativePath, `${JSON.stringify(packageValue, null, 2)}\n`, "utf8");

  const episodeWorkflow = createWorkflow({
    id: episode,
    kind: "episode",
    series: draft.series,
    subtype: draft.subtype,
    currentStage: "images",
    status: "waiting",
  });
  episodeWorkflow.approvals.content = true;
  episodeWorkflow.sourceDraft = draft.id;
  recordEvent(episodeWorkflow, "draft-promoted", {draftId: draft.id});
  await refreshEpisodeWorkflow(factoryRoot, episodeWorkflow);

  draft.status = "promoted";
  draft.promotedTo = episode;
  draft.currentStage = "completed";
  draft.nextAction = `Continue production as ${episode}.`;
  draft.approvals.content = true;
  recordEvent(draft, "content-approved-and-promoted", {episode});
  await writeWorkflow(factoryRoot, draft);
  console.log(`Approved ${draft.id} and promoted it to ${episode}.`);
  console.log(`Next: prepare images in inbox/${episode}/, then continue ${episode}.`);
}

async function materializeEpisodeLessonFromChatPackage(workflow) {
  const inboxRoot = path.join(factoryRoot, "inbox", workflow.id);
  const lessonPath = path.join(inboxRoot, "lesson.json");
  try {
    await readFile(lessonPath);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const workflowRoot = path.dirname(resolveWorkflowPath(factoryRoot, workflow.id));
  const packagePath = path.join(workflowRoot, "chat-package.json");
  let packageValue;
  try {
    packageValue = validateChatPackage(
      JSON.parse(await readFile(packagePath, "utf8")),
      {
        draftId: workflow.id,
        series: workflow.series,
        subtype: workflow.subtype,
      },
    );
  } catch (error) {
    throw new Error(
      `Cannot approve content without lesson.json or a valid Chat package: ${error.message}`,
    );
  }
  const existingFiles = new Set(await readFiles(inboxRoot));
  const lesson = {
    episode: workflow.id,
    series: workflow.series,
    subtype: workflow.subtype,
    title: packageValue.title,
    language: packageValue.language ?? "en",
    level: packageValue.level ?? "A2",
    renderMode: "double-pass-shadowing",
    countdownSeconds: 4,
    transitionSeconds: 0.4,
    tts: {provider: "edge", voice: "en-US-JennyNeural", rate: "+0%"},
    video: {width: 1920, height: 1080, fps: 30},
    scenes: packageValue.scenes.map((scene, index) => {
      const padded = `scene${String(index + 1).padStart(2, "0")}.png`;
      const unpadded = `scene${index + 1}.png`;
      return {
        id: `scene${String(index + 1).padStart(2, "0")}`,
        image: existingFiles.has(padded) ? padded : unpadded,
        sentences: scene.sentences.map((text) => ({text})),
      };
    }),
  };
  await mkdir(inboxRoot, {recursive: true});
  await writeFile(lessonPath, `${JSON.stringify(lesson, null, 2)}\n`, "utf8");
  recordEvent(workflow, "lesson-created-from-approved-chat-package", {
    lesson: relative(lessonPath),
  });
}

async function ensureHandoffPrompt(workflow, category) {
  const promptRoot = path.join(
    path.dirname(resolveWorkflowPath(factoryRoot, workflow.id)),
    "handoff",
  );
  await mkdir(promptRoot, {recursive: true});
  const promptPath = path.join(promptRoot, "chat-prompt.txt");
  const prompt = buildChatPrompt({
    draftId: workflow.id,
    series: workflow.series,
    subtype: workflow.subtype,
    category,
  });
  await writeFile(promptPath, `${prompt}\n`, "utf8");
  return promptPath;
}

function inferCategory(episode) {
  if (/^ESSD-\d{4}$/.test(episode))
    return {series: "ESSD", subtype: "classic-twisted"};
  if (/^LLFC-\d{4}$/.test(episode)) return {series: "LLFC", subtype: "default"};
  return null;
}

function printCategories() {
  for (const [series, seriesValue] of Object.entries(registry.series)) {
    for (const [subtype, value] of Object.entries(seriesValue.subtypes)) {
      console.log(`- ${series} / ${subtype}: ${value.label}`);
    }
  }
}

function printWorkflowLine(workflow) {
  console.log(
    `- ${workflow.id} | ${workflow.series}/${workflow.subtype} | ` +
      `${workflow.currentStage} | ${workflow.status}`,
  );
}

function printWorkflowDetail(workflow) {
  printWorkflowLine(workflow);
  if (workflow.nextAction) console.log(`  Next: ${workflow.nextAction}`);
  if (workflow.blocker) console.log(`  Blocker: ${workflow.blocker}`);
}

async function requireWorkflow(id) {
  if (!id) throw new Error("A workflow ID is required.");
  const workflow = await readWorkflow(factoryRoot, id);
  if (!workflow) throw new Error(`Workflow not found: ${id}`);
  return workflow;
}

async function nextDraftId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const draftsRoot = path.join(factoryRoot, "projects", "_drafts");
  const existing = await readDirectories(draftsRoot);
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

async function readFiles(directory) {
  try {
    return (await readdir(directory, {withFileTypes: true}))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function relative(value) {
  return path.relative(factoryRoot, value).replaceAll(path.sep, "/");
}
