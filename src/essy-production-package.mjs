import {readFileSync} from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

// Native ESSY production package: deterministic handoff from an approved ESSY
// draft (ENGLISH + PREPARE + STORYBOARD/Gate 2) into BUILD. It references the
// canonical artifacts instead of duplicating them and carries no editorial
// decisions. LLFC production packages (contracts/production-package.schema.json)
// are a separate contract and must never masquerade as this one.

const schema = JSON.parse(
  readFileSync(
    new URL("../contracts/essy-production-package.schema.json", import.meta.url),
    "utf8",
  ),
);
const validateSchema = new Ajv2020({allErrors: true, strict: false}).compile(schema);

const MARKDOWN_WRAPPER = /```|^\s*#{1,6}\s|^\s*[-*]\s/m;

export function validateEssyProductionPackage(value, expected = {}) {
  if (!validateSchema(value)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`ESSY production package schema validation failed: ${details}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ESSY production package must be a JSON object.");
  }
  for (const field of ["draftId", "series", "title", "language"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`ESSY production package requires non-empty "${field}".`);
    }
  }
  if (MARKDOWN_WRAPPER.test(value.title)) {
    throw new Error('ESSY production package "title" must not contain Markdown wrappers.');
  }
  for (const field of ["draftId", "series", "language"]) {
    if (expected[field] && value[field] !== expected[field]) {
      throw new Error(
        `ESSY production package ${field} must be "${expected[field]}".`,
      );
    }
  }
  if (expected.language && value.language !== expected.language) {
    throw new Error(`ESSY production package language must be "${expected.language}".`);
  }
  return value;
}
