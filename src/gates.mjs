import {readFile, stat} from "node:fs/promises";
import path from "node:path";
import {normalizeLesson, resolveInside} from "./lesson.mjs";

export const STAGES = Object.freeze([
  "intake",
  "creative-development",
  "content-approval",
  "images",
  "render-ready",
  "rendering",
  "qa",
  "completed",
]);

export async function evaluateEpisodeGates({factoryRoot, episode, series, subtype}) {
  const inboxRoot = path.join(factoryRoot, "inbox", episode);
  const lessonPath = path.join(inboxRoot, "lesson.json");
  const result = {
    lesson: {passed: false, reason: null},
    contentApproval: {passed: false, reason: "Content approval has not been recorded."},
    images: {passed: false, reason: null, missing: []},
    render: {passed: false, reason: null},
    qa: {passed: false, reason: null},
  };

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
    lesson = normalizeLesson(raw, episode);
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
  return "completed";
}
