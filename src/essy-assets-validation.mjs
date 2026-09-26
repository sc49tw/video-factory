import {readFileSync} from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

// ESSY ASSETS machine completion: records that production assets were
// downloaded, bijected 1:1 against the canonical approved-slot-asset-map and
// storyboard, ffprobe-validated, and duration-fit against narration windows.
// Purely deterministic validation status — no editorial decision, and no
// human approval gate (the draft ASSETS stage completes machine-only).

const schema = JSON.parse(
  readFileSync(
    new URL("../contracts/essy-assets-validation.schema.json", import.meta.url),
    "utf8",
  ),
);
const validateSchema = new Ajv2020({allErrors: true, strict: false}).compile(schema);

export function validateEssyAssetsValidation(value, expected = {}) {
  if (!validateSchema(value)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`ESSY assets validation schema failed: ${details}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ESSY assets validation must be a JSON object.");
  }
  for (const field of ["draftId", "series"]) {
    if (expected[field] && value[field] !== expected[field]) {
      throw new Error(`ESSY assets validation ${field} must be "${expected[field]}".`);
    }
  }
  if (value.expectedAssets !== value.validatedAssets) {
    throw new Error(
      `ESSY assets validation expectedAssets (${value.expectedAssets}) ` +
        `!= validatedAssets (${value.validatedAssets}).`,
    );
  }
  return value;
}
