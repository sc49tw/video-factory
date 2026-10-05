#!/usr/bin/env node
// Headless smoke test for the ESSY-0005 Gate 2 narrative review page.
// Loads the inline review script from narrative-review-page.html into a minimal
// DOM shim and verifies the rendered page and its export behavior.
// Read-only: writes only its own report.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "narrative-review-page.html"), "utf8");
const dataJson = fs.readFileSync(path.join(here, "narrative-review-data.json"), "utf8");

const results = [];
const check = (id, pass, detail) => {
  results.push({ id, status: pass ? "pass" : "fail", detail });
  return pass;
};

// ---- minimal DOM shim -------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = "";
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.listeners = {};
    this._text = "";
    this.value = "";
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        this.className = [...set].join(" ");
      },
      remove: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        this.className = [...set].join(" ");
      },
      contains: (n) => this.className.split(/\s+/).includes(n),
      toggle: (n) => (this.classList.contains(n) ? this.classList.remove(n) : this.classList.add(n)),
    };
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  appendChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parent = null;
    }
    return child;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
  }
  getAttribute(name) {
    return this.attrs[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) fn({ target: this });
  }
  dispatch(type, event) {
    for (const fn of this.listeners[type] || []) fn(event || { target: this });
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
  matches(selector) {
    if (selector.startsWith("[")) {
      const withValue = selector.match(/^\[([a-z-]+)="([^"]*)"\]$/);
      if (withValue) return this.getAttribute(withValue[1]) === withValue[2];
      const presence = selector.match(/^\[([a-z-]+)\]$/);
      return Boolean(presence) && this.attrs[presence[1]] !== undefined;
    }
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(selector) {
    return this.descendants().filter((n) => n.matches && n.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const byId = new Map();
const document = {
  createElement: (tag) => new El(tag),
  getElementById: (id) => {
    if (!byId.has(id)) {
      const el = new El(id === "review-data" || id === "exportout" ? "pre" : "div");
      if (id === "review-data") el.textContent = dataJson;
      if (id === "filter") el.value = "all";
      if (id !== "review-data") document.body.appendChild(el);
      byId.set(id, el);
    }
    return byId.get(id);
  },
  body: new El("body"),
  querySelectorAll: (selector) => document.body.querySelectorAll(selector),
  querySelector: (selector) => document.body.querySelector(selector),
};

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const blobs = [];
class Blob {
  constructor(parts) {
    this.text = parts.join("");
  }
}
const URL = { createObjectURL: (blob) => (blobs.push(blob), "blob:mock"), revokeObjectURL: () => {} };

const script = html.split(/<script>/).slice(1).map((part) => part.split(/<\/script>/)[0]).pop();
check("inline-script-present", typeof script === "string" && script.includes("render()"), "review script extracted from the page");

const run = new Function("document", "localStorage", "Blob", "URL", "navigator", "setTimeout", script);
run(document, localStorage, Blob, URL, { clipboard: { writeText: () => {} } }, (fn) => fn());

// ---- assertions -------------------------------------------------------------
const main = document.getElementById("main");
const slots = main.querySelectorAll(".slot");
const cands = main.querySelectorAll(".cand");
const videos = main.querySelectorAll("video");
const imgs = main.querySelectorAll("img");
const data = JSON.parse(dataJson);
const expectedCandidates = data.blocks.flatMap((b) => b.slots).reduce((n, s) => n + s.candidates.length, 0);
const expectedVideos = data.counts.videos;
const expectedPhotos = data.counts.photos;

check("renders-43-slots", slots.length === 43, `${slots.length} slot panels`);
check("renders-18-blocks", main.querySelectorAll(".block").length === 18, `${main.querySelectorAll(".block").length} narration blocks`);
check("renders-all-candidates", cands.length === expectedCandidates, `${cands.length}/${expectedCandidates} candidate cards`);
check("video-first-previews", videos.length === expectedVideos && imgs.length === expectedPhotos, `video previews=${videos.length} photo thumbnails=${imgs.length}`);
check("four-controls-per-slot", main.querySelectorAll('[data-decision]').length === 43 * 4, `${main.querySelectorAll('[data-decision]').length} decision controls`);
check("notes-field-per-slot", main.querySelectorAll("textarea").length === 43, `${main.querySelectorAll("textarea").length} notes fields`);
check("watched-badges", main.descendants().filter((n) => n.textContent === "reviewed / provisional keep").length === 7, "7 previously watched videos badged");
check("alignment-banner", html.includes("Exact sentence-to-slot alignment is NOT available"), "alignment limitation stated in the page");
const mainText = main.textContent;
check(
  "narration-and-translation-rendered",
  mainText.includes(data.blocks[0].narrationEn[0]) &&
    mainText.includes(data.blocks[0].narrationZhHant[0]) &&
    mainText.includes("Reference translation (zh-Hant) - not narration"),
  "approved English narration and the marked reference translation render per slot",
);
check(
  "sequence-context-rendered",
  mainText.includes("Sequence context (from approved storyboard)") &&
    mainText.includes("Following slot N002-S1") &&
    mainText.includes("Preceding slot (none - first slot of the episode)"),
  "preceding / following slot context derived from the approved storyboard",
);
check(
  "side-by-side-layout",
  /\.slot \{ display: grid; grid-template-columns: minmax\(320px, 30%\) 1fr/.test(html) && /@media \(max-width: 1100px\)/.test(html),
  "narration column and candidate column side by side on desktop, stacked on narrow screens",
);
check(
  "summary-rendered",
  document.getElementById("summary").textContent.includes("Selected for proposal") &&
    document.getElementById("summary").textContent.includes("Unresolved") &&
    document.getElementById("summary").textContent.includes("approved (Gate 2 approval is a separate human decision)"),
  "summary shows reviewed / unresolved / selected-for-proposal and claims no approval",
);

// simulate reviewer actions
const slotEl = (slotId) => main.querySelectorAll(".slot").find((s) => s.dataset.slotid === slotId);
slotEl("N001-S1").querySelector('[data-decision="provisional-keep"]').click();
const refreshedSlot = slotEl("N001-S1");
refreshedSlot.querySelector('[data-decision="provisional-keep"]').classList.contains("on");
check("decision-toggles-on", refreshedSlot.querySelector('[data-decision="provisional-keep"]').classList.contains("on"), "provisional keep renders as active");
const firstCard = refreshedSlot.querySelector(".cand");
firstCard.querySelector('[data-mark="provisional-keep"]').click();
slotEl("N002-S1").querySelector('[data-decision="needs-another-search"]').click();
const notesArea = slotEl("N018-S3").querySelector("textarea");
notesArea.value = "no road candidate yet";
notesArea.dispatch("input");

document.getElementById("export").click();
check("export-produces-json", blobs.length === 1, "export button produced a downloadable payload");
const payload = JSON.parse(blobs[blobs.length - 1].text);
check("export-43-slots", payload.slots.length === 43, `${payload.slots.length} slot entries exported`);
check("export-decision", payload.slots.find((s) => s.slotId === "N001-S1").decision === "provisional-keep", "slot decision exported");
check(
  "export-candidate-keep",
  payload.slots.find((s) => s.slotId === "N001-S1").candidates.length === 1 &&
    payload.slots.find((s) => s.slotId === "N001-S1").candidates[0].provisionalKeep === true,
  "candidate-level provisional keep exported with round provenance",
);
check("export-needs-search", payload.slots.find((s) => s.slotId === "N002-S1").decision === "needs-another-search", "needs-another-search exported");
check("export-notes", payload.slots.find((s) => s.slotId === "N018-S3").notes === "no road candidate yet", "editorial notes exported");
check("export-summary", payload.summary.selectedForProposalSlots === 1 && payload.summary.unresolvedSlots === 40 && payload.summary.reviewedSlots === 3, JSON.stringify(payload.summary));
check("export-not-approved", payload.approvalStatus === "not-approved", "export carries no approval claim");
check("local-only", !fs.readdirSync(here).some((f) => /decisions\.json$/.test(f)) && store.has("essy-0005-narrative-review-v1"), "decisions stay in the page (localStorage) and no decision file is written to the repository");

const failed = results.filter((r) => r.status === "fail");
const report = {
  schemaVersion: "1.0",
  episode: data.episode,
  artifact: "narrative-review-page-smoke-test",
  testedAt: new Date().toISOString(),
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  checks: results,
};
fs.writeFileSync(path.join(here, "narrative-review-smoke-test.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ totals: report.totals, failures: failed }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
