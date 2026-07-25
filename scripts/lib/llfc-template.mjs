import {readFile} from "node:fs/promises";
import path from "node:path";

export async function loadLlfcProject(factoryRoot, projectPath) {
  const defaultsPath = path.join(
    factoryRoot,
    "templates",
    "llfc",
    "defaults.json",
  );
  const [defaults, project] = await Promise.all([
    readJson(defaultsPath),
    readJson(projectPath),
  ]);
  return deepMerge(defaults, project);
}

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.map(clone);
  if (!isObject(base) || !isObject(override)) return clone(override);

  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] =
      isObject(result[key]) && isObject(value)
        ? deepMerge(result[key], value)
        : clone(value);
  }
  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    );
  }
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
