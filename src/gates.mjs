import {readFile, stat} from "node:fs/promises";
import path from "node:path";
import {
  isEssayInput,
  normalizeEssayEpisode,
} from "./essay-episode.mjs";
import {normalizeLesson, resolveInside} from "./lesson.mjs";

export const STAGES = Object.freeze([
  "intake",
  "creative-development",
  "content-approval",
  "images",
  "render-ready",
  "rendering",
  "qa",
  "final-assembly",
  "completed",
]);

export async function evaluateEpisodeGates({factoryRoot, episode, series, subtype}) {
  // Renderer input: inbox is canonical, projects/<EP>/source/lesson.json is the
  // accepted fallback used by the ESSY final-assembly pipeline.
  let inboxRoot = path.join(factoryRoot, "inbox", episode);
  let lessonPath = path.join(inboxRoot, "lesson.json");
  let usingFallbackLesson = false;
  try {
    await stat(lessonPath);
  } catch {
    const fallbackPath = path.join(
      factoryRoot, "projects", episode, "source", "lesson.json",
    );
    try {
      await stat(fallbackPath);
      usingFallbackLesson = true;
      lessonPath = fallbackPath;
      inboxRoot = path.dirname(fallbackPath);
    } catch {
      // fall through: report the canonical inbox path as missing
    }
  }
  const result = {
    lesson: {passed: false, reason: null},
    contentApproval: {passed: false, reason: "Content approval has not been recorded."},
    images: {passed: false, reason: null, missing: []},
    render: {passed: false, reason: null},
    qa: {passed: false, reason: null},
    // Vacuously passed for series without a final-assembly stage (ESSD/LLFC).
    // For ESSY it becomes applicable and is evaluated below.
    finalRender: {passed: true, reason: null, applicable: false},
  };

  // ---- ESSY final-assembly gate ----
  // Evaluated independently of the lesson gate so a missing renderer input can
  // never hide a final-assembly drift. Applicable only when the episode
  // declares a Final-Assembly spec (projects/<EP>/final-assembly.json). A
  // final MP4 alone is NOT enough: the gate requires the renderer's technical
  // QA artifact (temp/final-assembly/final-assembly-qa.json) with a passing
  // subtitle QA. Human sign-off is a separate approval (finalQa).
  let finalAssemblySpec = null;
  try {
    finalAssemblySpec = JSON.parse(
      await readFile(
        path.join(factoryRoot, "projects", episode, "final-assembly.json"),
        "utf8",
      ),
    );
  } catch {
    finalAssemblySpec = null;
  }
  if (finalAssemblySpec) {
    result.finalRender.applicable = true;
    const finalQaPath = path.join(
      factoryRoot, "projects", episode, "temp", "final-assembly",
      "final-assembly-qa.json",
    );
    try {
      const finalQa = JSON.parse(await readFile(finalQaPath, "utf8"));
      const subtitleQaRecorded = finalQa.subtitleQa != null;
      const subtitleQaPassed =
        !subtitleQaRecorded || finalQa.subtitleQa.passed === true; // legacy masters predate the shared subtitle QA gate
      const outputExists = finalQa.output
        ? (await stat(path.join(factoryRoot, finalQa.output))).isFile()
        : false;
      result.finalRender.passed = subtitleQaPassed && outputExists;
      result.finalRender.output = finalQa.output ?? null;
      result.finalRender.reason = result.finalRender.passed
        ? null
        : !outputExists
          ? `Final assembly QA output is missing: ${finalQa.output ?? "unrecorded"}.`
          : "Final assembly subtitle QA has not passed.";
    } catch {
      result.finalRender.passed = false;
      result.finalRender.reason =
        "Final assembly has not been rendered (missing final-assembly-qa.json).";
    }
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(lessonPath, "utf8"));
  } catch (error) {
    result.lesson.reason =
      error?.code === "ENOENT"
        ? `Waiting for ${path.relative(factoryRoot, lessonPath)}.`
        : `Invalid lesson.json: ${error.message}`;
    return result;
  }

  let lesson;
  try {
    lesson = isEssayInput(raw)
      ? await normalizeEssayEpisode(raw, episode, inboxRoot)
      : normalizeLesson(raw, episode);
  } catch (error) {
    result.lesson.reason = error.message;
    return result;
  }
  if (lesson.series && lesson.series !== series) {
    result.lesson.reason = `lesson.json series "${lesson.series}" does not match "${series}".`;
    return result;
  }
  if (lesson.subtype && lesson.subtype !== subtype) {
    result.lesson.reason = `lesson.json subtype "${lesson.subtype}" does not match "${subtype}".`;
    return result;
  }
  result.lesson = {passed: true, reason: null, sentenceCount: lesson.sentences.length};

  for (const scene of lesson.scenes) {
    const imagePath = resolveInside(inboxRoot, scene.image, "Scene image");
    try {
      const imageStat = await stat(imagePath);
      if (!imageStat.isFile() || imageStat.size === 0) result.images.missing.push(scene.image);
    } catch {
      result.images.missing.push(scene.image);
    }
  }
  result.images.missing = [...new Set(result.images.missing)];
  result.images.passed = result.images.missing.length === 0;
  result.images.reason = result.images.passed
    ? null
    : `Missing images: ${result.images.missing.join(", ")}`;

  const manifestPath = path.join(factoryRoot, "projects", episode, "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    result.render.passed = manifest.status === "success";
    result.render.reason = result.render.passed
      ? null
      : manifest.error ?? "Render has not completed successfully.";
    result.qa.passed = manifest.validation?.passed === true;
    result.qa.reason = result.qa.passed ? null : "Output validation has not passed.";
  } catch {
    result.render.reason = "Final render has not been produced.";
    result.qa.reason = "Output QA has not run.";
  }
  return result;
}

export function nextStageFromGates(gates, approvals = {}) {
  if (!gates.lesson.passed) return "creative-development";
  if (!approvals.content) return "content-approval";
  if (!gates.images.passed) return "images";
  if (!gates.render.passed) return "render-ready";
  if (!gates.qa.passed) return "qa";
  if (!approvals.qa) return "qa";
  if (gates.finalRender?.applicable) {
    if (!gates.finalRender.passed) return "final-assembly";
    if (!approvals.finalQa) return "final-assembly";
  }
  return "completed";
}
