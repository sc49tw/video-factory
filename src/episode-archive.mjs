// Episode archival for both authoritative episode record kinds:
//
//   - draft-backed episodes (current ESSY): projects/_drafts/<EP>/state.yaml
//   - workflow-backed episodes (legacy):     projects/<EP>/workflow.json
//
// Archival is never automatic and is never inferred from production state. Two
// independent conditions must both hold: the operator passes the explicit
// `--published` confirmation, and the authoritative record shows the episode is
// completed with its approval gates satisfied.
//
// The authoritative record is resolved draft-first, exactly like the workflow
// CLI's approve/status commands and src/publication.mjs resolveEpisodeLifecycle.
// A draft-backed episode therefore archives from state.yaml alone; it never
// requires a legacy projects/<EP>/workflow.json.
//
// The transition is transactional: eligibility is fully validated before any
// write, the authoritative record is snapshotted, and every mutation is rolled
// back on failure. A failed archive leaves the episode exactly as it was rather
// than a half-archived episode with a dangling `completed` draft.
import {mkdir, rename, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {readDraftState, writeDraftState} from "./draft-workflow.mjs";
import {
  readWorkflow,
  recordEvent,
  refreshEpisodeWorkflow,
  writeWorkflow,
} from "./workflow.mjs";

export const ARCHIVE_CONFIRMATION = "--published";
export const ARCHIVE_REASON = "published";

// Canonical archive layout, unchanged from the legacy workflow-backed archive:
//   archive/episodes/<EPISODE>/{inbox,project,output}/ + archive.json
export const ARCHIVE_LOCATIONS = Object.freeze({
  inbox: "inbox/",
  project: "project/",
  output: "output/",
});

// Statuses that mean "this record is finished"; `continue` must not offer them
// as unfinished work. An archived episode is terminal, exactly like a completed
// one; a rendered final MP4 or a completed draft is NOT an archive.
export const TERMINAL_DRAFT_STATUSES = Object.freeze(["completed", "archived"]);
export const TERMINAL_WORKFLOW_STATUSES = Object.freeze(["completed", "archived"]);

export function episodeArchiveRoot(factoryRoot, episode) {
  return path.join(factoryRoot, "archive", "episodes", episode);
}

export async function isEpisodeArchived(factoryRoot, episode) {
  return isFile(path.join(episodeArchiveRoot(factoryRoot, episode), "archive.json"));
}

/**
 * Resolve the authoritative record for an episode. Draft state wins over a
 * legacy production workflow.json, matching the workflow CLI and the
 * publication lifecycle resolver.
 */
export async function resolveArchiveRecord(factoryRoot, episode) {
  const state = await readDraftState(factoryRoot, episode);
  if (state) {
    return {
      kind: "draft",
      episode,
      state,
      source: `projects/_drafts/${episode}/state.yaml`,
    };
  }
  const workflow = await readWorkflow(factoryRoot, episode);
  if (workflow && workflow.kind === "episode") {
    return {
      kind: "workflow",
      episode,
      workflow,
      source: `projects/${episode}/workflow.json`,
    };
  }
  throw new Error(`Episode workflow not found: ${episode}`);
}

/**
 * Draft-backed archive eligibility, derived from the authoritative draft
 * lifecycle only. A draft reaches status `completed` exclusively through
 * `approve <EP> final-assembly`, which already requires the QA approval and a
 * rendered final master; both approvals are re-checked here so archival can
 * never be weakened by a hand-edited status.
 */
export function draftArchiveBlockers(state) {
  const blockers = [];
  const status = String(state?.status ?? "");
  if (status === "archived") {
    blockers.push("the draft is already archived");
    return blockers;
  }
  if (status !== "completed") {
    blockers.push(`draft status is "${status || "unknown"}"`);
  }
  if (state?.approvals?.qa?.approved !== true) {
    blockers.push("QA is not approved");
  }
  if (state?.approvals?.finalAssembly?.approved !== true) {
    blockers.push("final assembly is not approved");
  }
  return blockers;
}

/**
 * Legacy workflow-backed eligibility. `status === "completed"` is itself
 * gate-derived: refreshEpisodeWorkflow() only reconciles a workflow to
 * `completed` once the lesson, image, render and QA gates pass AND, when the
 * episode declares a Final-Assembly spec, the final render plus its final
 * sign-off. Archive therefore re-checks the refreshed status rather than
 * re-implementing the gate graph.
 */
export function workflowArchiveBlockers(workflow) {
  const blockers = [];
  if (workflow.status === "archived" || workflow.currentStage === "archived") {
    blockers.push("the episode workflow is already archived");
    return blockers;
  }
  if (workflow.status !== "completed") {
    blockers.push(`workflow status is "${String(workflow.status ?? "unknown")}"`);
  }
  if (workflow.approvals?.qa !== true) {
    blockers.push("QA is not approved");
  }
  return blockers;
}

/**
 * Archive a published episode into archive/episodes/<EPISODE>/.
 *
 * @param {object} options
 * @param {string} options.factoryRoot repository root
 * @param {string} options.episode episode ID
 * @param {string} [options.confirmation] must be the explicit `--published` flag
 */
export async function archiveEpisodeRecord({
  factoryRoot,
  episode,
  confirmation,
}) {
  if (!episode) {
    throw new Error("An episode ID is required.");
  }
  if (confirmation !== ARCHIVE_CONFIRMATION) {
    throw new Error(
      "Archive requires explicit publication confirmation: archive <ID> --published",
    );
  }
  const archiveRoot = episodeArchiveRoot(factoryRoot, episode);
  if (await isFile(path.join(archiveRoot, "archive.json"))) {
    throw new Error(
      `Episode is already archived at ${relativeTo(factoryRoot, archiveRoot)}.`,
    );
  }
  const record = await resolveArchiveRecord(factoryRoot, episode);
  if (record.kind === "workflow") {
    // Legacy episodes are gate-reconciled before eligibility is evaluated, so a
    // drifted workflow cannot be archived on a stale `completed` status.
    await refreshEpisodeWorkflow(factoryRoot, record.workflow);
  }
  const blockers =
    record.kind === "draft"
      ? draftArchiveBlockers(record.state)
      : workflowArchiveBlockers(record.workflow);
  if (blockers.length > 0) {
    throw new Error(rejectionMessage(record, blockers));
  }

  // Validate every archive target before creating anything, so a rejected
  // archive leaves no empty archive/episodes/<EPISODE>/ behind.
  const sources = await existingSources(factoryRoot, episode);
  for (const [name] of sources) {
    const target = path.join(archiveRoot, name);
    if (await pathExists(target)) {
      throw new Error(
        `Archive target already exists: ${relativeTo(factoryRoot, target)}.`,
      );
    }
  }
  await mkdir(archiveRoot, {recursive: true});

  const archivedAt = new Date().toISOString();
  const snapshot = snapshotRecord(record);
  const undo = [];
  try {
    await applyArchival(record, factoryRoot, archivedAt);
    undo.push(() => restoreRecord(record, factoryRoot, snapshot));
    for (const [name, source] of sources) {
      await rename(source, path.join(archiveRoot, name));
      undo.push(() => rename(path.join(archiveRoot, name), source));
    }
    await writeJson(path.join(archiveRoot, "archive.json"), {
      episode,
      archivedAt,
      reason: ARCHIVE_REASON,
      locations: {...ARCHIVE_LOCATIONS},
      stateSource: record.source,
    });
  } catch (error) {
    const failures = [];
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (rollbackError) {
        failures.push(rollbackError.message);
      }
    }
    const detail = failures.length
      ? ` Rollback also failed for: ${failures.join("; ")}`
      : " The episode was left unchanged.";
    throw new Error(`Archive of ${episode} failed: ${error.message}.${detail}`);
  }
  return {
    episode,
    kind: record.kind,
    source: record.source,
    archivedAt,
    archiveRoot,
    moved: sources.map(([name]) => ARCHIVE_LOCATIONS[name]),
  };
}

// --- record transitions -----------------------------------------------------

function applyArchival(record, factoryRoot, archivedAt) {
  if (record.kind === "draft") {
    return applyDraftArchival(factoryRoot, record.state, archivedAt);
  }
  return applyWorkflowArchival(factoryRoot, record.workflow, archivedAt);
}

function applyDraftArchival(factoryRoot, state, archivedAt) {
  // status transitions completed -> archived and `archivedAt` is recorded.
  // currentStage deliberately stays put: RENDER is where the episode finished,
  // and the draft's own invariant (a DRAFT_STAGES member) must survive archival
  // so the record stays readable.
  state.status = "archived";
  state.archivedAt = archivedAt;
  state.history ??= [];
  state.history.push({at: archivedAt, event: "episode-archived", reason: ARCHIVE_REASON});
  return writeDraftState(factoryRoot, state);
}

function applyWorkflowArchival(factoryRoot, workflow, archivedAt) {
  workflow.currentStage = "archived";
  workflow.status = "archived";
  workflow.archivedAt = archivedAt;
  workflow.nextAction = "Archived after publication confirmation.";
  recordEvent(workflow, "episode-archived", {reason: ARCHIVE_REASON});
  return writeWorkflow(factoryRoot, workflow);
}

function snapshotRecord(record) {
  return JSON.parse(
    JSON.stringify(record.kind === "draft" ? record.state : record.workflow),
  );
}

async function restoreRecord(record, factoryRoot, snapshot) {
  return record.kind === "draft"
    ? writeDraftState(factoryRoot, snapshot)
    : writeWorkflow(factoryRoot, snapshot);
}

// --- helpers ----------------------------------------------------------------

function rejectionMessage(record, blockers) {
  const detail = blockers.join("; ");
  if (record.kind === "draft") {
    return (
      `Only a completed, QA- and final-assembly-approved episode can be archived ` +
      `(draft ${record.episode}: ${detail}).`
    );
  }
  return `Only a completed, QA-approved episode can be archived (${detail}).`;
}

async function existingSources(factoryRoot, episode) {
  const candidates = [
    ["inbox", path.join(factoryRoot, "inbox", episode)],
    ["project", path.join(factoryRoot, "projects", episode)],
    ["output", path.join(factoryRoot, "output", episode)],
  ];
  const sources = [];
  for (const [name, source] of candidates) {
    if (await pathExists(source)) sources.push([name, source]);
  }
  return sources;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(value) {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function isFile(value) {
  try {
    return (await stat(value)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function relativeTo(factoryRoot, value) {
  return path.relative(factoryRoot, value).replaceAll(path.sep, "/");
}