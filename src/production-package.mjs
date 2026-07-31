import {readFileSync} from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../contracts/production-package.schema.json", import.meta.url),
    "utf8",
  ),
);
const validateSchema = new Ajv2020({allErrors: true, strict: false}).compile(schema);

const FORBIDDEN_PROMPT_REQUEST =
  /\b(add|include|show|display|render|write|with|containing)\b[^.]{0,60}\b(captions?|subtitles?|logos?|embedded text|text overlay|on-screen text)\b/i;
const MARKDOWN_WRAPPER = /```|^\s*#{1,6}\s|^\s*[-*]\s/m;

export function validateProductionPackage(value, expected = {}) {
  if (!validateSchema(value)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Production package schema validation failed: ${details}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Production package must be a JSON object.");
  }
  for (const field of [
    "draftId",
    "series",
    "subtype",
    "title",
    "language",
    "level",
    "summary",
  ]) {
    requirePlainString(value[field], field);
  }
  if (value.series !== "LLFC") throw new Error('Production package series must be "LLFC".');
  if (value.language !== "en") throw new Error('Supported language is "en".');
  if (value.level !== "A2") throw new Error('Supported level is "A2".');
  for (const field of ["draftId", "series", "subtype"]) {
    if (expected[field] && value[field] !== expected[field]) {
      throw new Error(`Production package ${field} must be "${expected[field]}".`);
    }
  }
  requireArray(value.characters, "characters");
  for (const [index, character] of value.characters.entries()) {
    requirePlainString(character?.name, `characters[${index}].name`);
    requirePlainString(
      character?.visualDescription,
      `characters[${index}].visualDescription`,
    );
  }
  requireArray(value.scenes, "scenes");
  for (const [index, scene] of value.scenes.entries()) {
    if (scene?.scene !== index + 1) {
      throw new Error("Production package scene numbers must be sequential from 1.");
    }
    requirePlainString(scene.imageDescription, `scenes[${index}].imageDescription`);
    requirePlainString(scene.imagePrompt, `scenes[${index}].imagePrompt`);
    if (FORBIDDEN_PROMPT_REQUEST.test(scene.imagePrompt)) {
      throw new Error(
        `scenes[${index}].imagePrompt requests captions, subtitles, a logo, or embedded text.`,
      );
    }
    requireArray(scene.sentences, `scenes[${index}].sentences`);
    for (const [sentenceIndex, sentence] of scene.sentences.entries()) {
      requirePlainString(sentence, `scenes[${index}].sentences[${sentenceIndex}]`);
    }
  }
  return value;
}

function requirePlainString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Production package requires non-empty "${name}".`);
  }
  if (MARKDOWN_WRAPPER.test(value)) {
    throw new Error(`Production package "${name}" must not contain Markdown wrappers.`);
  }
}

function requireArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Production package requires non-empty "${name}".`);
  }
}
