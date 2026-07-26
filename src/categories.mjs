import {readFile, readdir} from "node:fs/promises";
import path from "node:path";

export async function loadCategoryRegistry(factoryRoot) {
  const registryPath = path.join(factoryRoot, "config", "video-categories.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  if (!registry?.series || typeof registry.series !== "object") {
    throw new Error(`Invalid category registry: ${registryPath}`);
  }
  return registry;
}

export function getCategory(registry, series, subtype) {
  const seriesEntry = registry.series?.[series];
  if (!seriesEntry) {
    throw new Error(
      `Unknown series "${series}". Available: ${Object.keys(registry.series).join(", ")}`,
    );
  }
  const subtypeEntry = seriesEntry.subtypes?.[subtype];
  if (!subtypeEntry) {
    throw new Error(
      `Unknown subtype "${subtype}" for ${series}. Available: ${Object.keys(
        seriesEntry.subtypes ?? {},
      ).join(", ")}`,
    );
  }
  return {series: seriesEntry, subtype: subtypeEntry};
}

export function validateEpisodeForCategory(registry, episode, series) {
  const entry = registry.series?.[series];
  if (!entry) {
    throw new Error(`Unknown series "${series}".`);
  }
  if (!new RegExp(entry.episodePattern).test(episode)) {
    throw new Error(
      `Episode "${episode}" does not match ${series} pattern ${entry.episodePattern}.`,
    );
  }
  return episode;
}

export async function nextEpisodeId(factoryRoot, registry, series) {
  const entry = registry.series?.[series];
  if (!entry) throw new Error(`Unknown series "${series}".`);
  const names = new Set();
  for (const rootName of ["inbox", "projects", "output"]) {
    const root = path.join(factoryRoot, rootName);
    for (const item of await readDirectoryNames(root)) names.add(item);
  }
  const matcher = new RegExp(entry.episodePattern);
  let highest = 0;
  for (const name of names) {
    if (!matcher.test(name)) continue;
    const number = Number(name.slice(entry.episodePrefix.length));
    if (Number.isInteger(number)) highest = Math.max(highest, number);
  }
  return `${entry.episodePrefix}${String(highest + 1).padStart(entry.digits, "0")}`;
}

async function readDirectoryNames(directory) {
  try {
    return (await readdir(directory, {withFileTypes: true}))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
