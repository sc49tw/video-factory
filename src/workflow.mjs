import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {evaluateEpisodeGates, nextStageFromGates, STAGES} from "./gates.mjs";

export async function readWorkflow(factoryRoot, id) {
  const workflowPath = resolveWorkflowPath(factoryRoot, id);
  try {
    return JSON.parse(await readFile(workflowPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeWorkflow(factoryRoot, workflow) {
  workflow.updatedAt = new Date().toISOString();
  const workflowPath = resolveWorkflowPath(factoryRoot, workflow.id);
  await mkdir(path.dirname(workflowPath), {recursive: true});
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  return workflowPath;
}

export function createWorkflow({id, kind, series, subtype, currentStage, status}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    id,
    kind,
    series,
    subtype,
    status,
    currentStage,
    createdAt: now,
    updatedAt: now,
    approvals: {content: false, images: false, qa: false},
    attempts: {},
    stages: Object.fromEntries(
      STAGES.map((stage) => [
        stage,
        {
          status:
            STAGES.indexOf(stage) < STAGES.indexOf(currentStage)
              ? "completed"
              : stage === currentStage
                ? status
                : "pending",
        },
      ]),
    ),
    blocker: null,
    nextAction: null,
    history: [],
  };
}

export async function refreshEpisodeWorkflow(factoryRoot, workflow) {
  const gates = await evaluateEpisodeGates({
    factoryRoot,
    episode: workflow.id,
    series: workflow.series,
    subtype: workflow.subtype,
  });
  if (workflow.needsRerender) {
    gates.render.passed = false;
    gates.render.reason = workflow.rerenderReason ?? "QA requested a new render.";
    gates.qa.passed = false;
    gates.qa.reason = "QA is waiting for the corrected render.";
  }
  const stage = nextStageFromGates(gates, workflow.approvals);
  workflow.currentStage = stage;
  workflow.approvals.qa ??= false;
  workflow.gates = gates;
  workflow.gates.contentApproval = {
    passed: workflow.approvals.content === true,
    reason: workflow.approvals.content
      ? null
      : "Content approval has not been recorded.",
  };
  workflow.status = stage === "completed" ? "completed" : statusForStage(stage);
  workflow.nextAction = nextActionForStage(workflow, stage, gates);
  workflow.blocker =
    workflow.status === "blocked" ? workflow.nextAction : null;
  for (const stageName of STAGES) {
    const stageIndex = STAGES.indexOf(stageName);
    const currentIndex = STAGES.indexOf(stage);
    workflow.stages[stageName] ??= {};
    workflow.stages[stageName].status =
      stageIndex < currentIndex
        ? "completed"
        : stageIndex === currentIndex
          ? workflow.status
          : "pending";
  }
  await writeWorkflow(factoryRoot, workflow);
  return workflow;
}

export async function listWorkflows(factoryRoot) {
  const results = [];
  const projectsRoot = path.join(factoryRoot, "projects");
  for (const entry of await safeReadDirectories(projectsRoot)) {
    if (entry === "_drafts") continue;
    const workflow = await readWorkflow(factoryRoot, entry);
    if (workflow) results.push(workflow);
  }
  const draftsRoot = path.join(projectsRoot, "_drafts");
  for (const entry of await safeReadDirectories(draftsRoot)) {
    const workflow = await readWorkflow(factoryRoot, entry);
    if (workflow) results.push(workflow);
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function recordEvent(workflow, event, detail = {}) {
  workflow.history.push({
    at: new Date().toISOString(),
    event,
    ...detail,
  });
  if (workflow.history.length > 100) workflow.history = workflow.history.slice(-100);
}

export function registerAttempt(workflow, stage, result, error = null) {
  const attempts = workflow.attempts[stage] ?? {
    total: 0,
    consecutiveFailures: 0,
    totalDurationMs: 0,
  };
  attempts.total += 1;
  attempts.lastAttemptAt = new Date().toISOString();
  attempts.lastResult = result;
  if (result === "failed") {
    attempts.consecutiveFailures += 1;
    attempts.lastError = error;
  } else {
    attempts.consecutiveFailures = 0;
    attempts.lastError = null;
  }
  workflow.attempts[stage] = attempts;
  if (attempts.consecutiveFailures >= 3) {
    workflow.status = "blocked";
    workflow.blocker = error;
    workflow.nextAction = `Resolve repeated ${stage} failure before continuing: ${error}`;
  }
}

export function resolveWorkflowPath(factoryRoot, id) {
  const root = id.startsWith("DRAFT-")
    ? path.join(factoryRoot, "projects", "_drafts", id)
    : path.join(factoryRoot, "projects", id);
  return path.join(root, "workflow.json");
}

function statusForStage(stage) {
  if (stage === "creative-development") return "waiting";
  if (stage === "content-approval") return "needs-approval";
  if (stage === "images") return "waiting";
  return "ready";
}

function nextActionForStage(workflow, stage, gates) {
  if (stage === "creative-development") return gates.lesson.reason;
  if (stage === "content-approval")
    return "Review the lesson content and explicitly approve it.";
  if (stage === "images") return gates.images.reason;
  if (stage === "render-ready")
    return `Run pnpm video:render ${workflow.id}`;
  if (stage === "qa") return "Review the rendered video and approve QA.";
  return "Production is complete.";
}

async function safeReadDirectories(directory) {
  try {
    return (await readdir(directory, {withFileTypes: true}))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
