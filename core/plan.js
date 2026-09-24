import fs from "fs";
import path from "path";

import { CATALOG_FILE } from "../scrapers/catalog.js";
import { normalizeUrl, MANIFEST_FILE } from "../scrapers/manifest.js";
import { detectLayout } from "./import.js";

/**
 * The study plan: user state over the scraped catalog, and the join that turns
 * the two into a task list.
 *
 * Strictly one-way. The scraper owns the catalog and never reads this file;
 * the front-end owns this file and never writes the catalog. They meet only at
 * read time, on the item id — which is `normalizeUrl(itemUrl)`, imported
 * rather than reimplemented, because a divergence between the two key spaces
 * would silently un-tick a user's completed work instead of failing loudly.
 *
 * The plan is append/update-only. Nothing is ever deleted automatically: an
 * item that disappears from its course becomes an orphan rendered from the
 * snapshot taken when it was last seen, which is what makes --prune safe to
 * run. Pruning deletes bytes and a manifest row; the task and its checkmark
 * survive.
 */

const PLAN_FILE = ".study-plan.json";
const PLAN_VERSION = 1;

/**
 * Normalizes an item id, preserving a synthetic fragment.
 *
 * normalizeUrl() drops the hash — correct for an asset URL, wrong here. The
 * catalog ids items that have no Canvas URL of their own by appending one:
 * `<normalized course url>#course` for the homepage, `<source>#<path>` for a
 * video file. Normalizing the whole string would collapse every such id onto
 * its base and silently file the entry under a key nothing joins back to.
 */
function itemKey(id) {
  const raw = String(id || "");
  const hash = raw.indexOf("#");
  if (hash === -1) return normalizeUrl(raw);
  return normalizeUrl(raw.slice(0, hash)) + raw.slice(hash);
}

/** Fields a caller may set on a plan entry. Anything else is ignored. */
const WRITABLE = new Set(["done", "target_date", "notes"]);

/** Reads a JSON file, or returns null. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

/** The plan file's path for an archive root. */
export function planPath(root) {
  return path.join(root, PLAN_FILE);
}

/**
 * Loads the plan for an archive root.
 *
 * An unrecognized version is treated as no plan rather than half-read — the
 * mistake the manifest makes by writing a version it never checks.
 */
export function readPlan(root) {
  const raw = readJson(planPath(root));
  if (!raw || raw.version !== PLAN_VERSION) {
    return { version: PLAN_VERSION, entries: {} };
  }
  if (!raw.entries || typeof raw.entries !== "object") raw.entries = {};
  return raw;
}

/**
 * Persists the plan atomically.
 *
 * Merges over the object it was given rather than rebuilding it, so fields
 * written by a newer build survive a save by an older one — precisely what
 * manifest.record() gets wrong.
 */
export function writePlan(root, plan) {
  const out = { ...plan, version: PLAN_VERSION, updated: new Date().toISOString() };
  const dest = planPath(root);
  const tmp = dest + ".part";
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, dest); // atomic — never a half-written plan
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e2) {
      /* ignore */
    }
    throw e;
  }
  return out;
}

/**
 * Applies updates to plan entries, creating them as needed.
 * @param {string} root
 * @param {Array<{itemId: string, done?: boolean, target_date?: string|null, notes?: string, snapshot?: object}>} updates
 */
export function updateEntries(root, updates) {
  const plan = readPlan(root);
  const now = new Date().toISOString();
  for (const u of updates || []) {
    if (!u || !u.itemId) continue;
    // Normalized on the way in too, so a caller passing a raw Canvas URL still
    // lands on the catalog's key — fragment preserved, see itemKey.
    const id = itemKey(u.itemId);
    const entry = plan.entries[id] || { created: now };
    for (const field of WRITABLE) {
      if (field in u) entry[field] = u[field];
    }
    if (u.done === true && !entry.done_at) entry.done_at = now;
    if (u.done === false) entry.done_at = null;
    if (u.snapshot) entry.snapshot = { ...(entry.snapshot || {}), ...u.snapshot };
    entry.updated = now;
    plan.entries[id] = entry;
  }
  return writePlan(root, plan);
}

/** Every course folder in an archive, following a --wiki/--octarine move. */
function courseDirs(root) {
  const layout = detectLayout(root);
  const base = layout.subdir ? path.join(root, layout.subdir) : root;
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(base, e.name))
      .filter((d) => fs.existsSync(path.join(d, MANIFEST_FILE)));
  } catch (e) {
    return [];
  }
}

/**
 * The task list: every catalog item in the archive, left-joined with the plan.
 *
 * Returns tasks in course order, plus the orphans — plan entries whose item is
 * no longer in any catalog — so a front-end can show them rather than pretend
 * completed work never happened.
 * @param {string} root archive directory
 */
export function loadStudyList(root) {
  const plan = readPlan(root);
  const seen = new Set();
  const courses = [];
  const tasks = [];

  for (const dir of courseDirs(root)) {
    const cat = readJson(path.join(dir, CATALOG_FILE));
    if (!cat || !Array.isArray(cat.items)) {
      // Scraped before the catalog existed. Say so rather than silently
      // omitting the course, which would read as "nothing here".
      courses.push({
        id: "",
        name: path.basename(dir),
        url: "",
        dir,
        indexed: false,
        total: 0,
        done: 0,
      });
      continue;
    }
    const course = {
      id: cat.course?.id || "",
      name: cat.course?.name || path.basename(dir),
      url: cat.course?.url || "",
      dir,
      indexed: true,
      total: 0,
      done: 0,
    };

    for (const item of cat.items) {
      if (!item || !item.id) continue;
      seen.add(item.id);
      const entry = plan.entries[item.id] || {};
      const primary = pickPrimaryFile(item);
      const task = {
        id: item.id,
        courseId: course.id,
        courseName: course.name,
        courseUrl: course.url,
        category: item.category,
        kind: item.kind,
        section: item.section,
        title: item.title,
        sortKey: item.sort_key,
        ordinal: item.global_ordinal ?? item.ordinal ?? 0,
        // Absolute, because the front-end hands this straight back to the
        // opener; the catalog stores it relative so it survives a relocation.
        localPath: primary ? path.join(dir, primary.path) : null,
        fileCount: item.files.length,
        bytes: item.files.reduce((n, f) => n + (Number(f.bytes) || 0), 0),
        canvasUrl: item.url || "",
        dueAt: item.due_at || null,
        unlockAt: item.unlock_at || null,
        state: item.state || "present",
        done: !!entry.done,
        doneAt: entry.done_at || null,
        targetDate: entry.target_date || null,
        notes: entry.notes || "",
        orphan: false,
      };
      task.exists = task.localPath ? fs.existsSync(task.localPath) : false;
      course.total++;
      if (task.done) course.done++;
      tasks.push(task);
    }
    courses.push(course);
  }

  // Plan entries with no catalog item left. Not deleted — rendered from the
  // snapshot, so ticking something off is never undone by a course changing.
  const orphans = [];
  for (const [id, entry] of Object.entries(plan.entries)) {
    if (seen.has(id)) continue;
    orphans.push({
      id,
      courseName: entry.snapshot?.course || "",
      courseUrl: entry.snapshot?.course_url || "",
      category: entry.snapshot?.category || "",
      kind: "",
      section: "",
      title: entry.snapshot?.title || id,
      sortKey: "9/9999/9999",
      ordinal: 0,
      localPath: null,
      fileCount: 0,
      bytes: 0,
      canvasUrl: "",
      dueAt: null,
      state: "orphan",
      done: !!entry.done,
      doneAt: entry.done_at || null,
      targetDate: entry.target_date || null,
      notes: entry.notes || "",
      exists: false,
      orphan: true,
    });
  }

  tasks.sort((a, b) =>
    a.courseName === b.courseName
      ? a.sortKey.localeCompare(b.sortKey)
      : a.courseName.localeCompare(b.courseName)
  );

  return { root, courses, tasks, orphans, planEntries: Object.keys(plan.entries).length };
}

/**
 * The file a task should open.
 *
 * An item's own rendered page is the right landing place — the assignment or
 * module as Canvas showed it — and the attachments hang off that. Falls back
 * to whatever is there, and to the largest file when nothing is marked, which
 * for a video item is the recording.
 */
function pickPrimaryFile(item) {
  if (!item.files || !item.files.length) return null;
  return (
    item.files.find((f) => f.role === "page") ||
    item.files.find((f) => f.role === "media") ||
    item.files.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0] ||
    null
  );
}

export default { loadStudyList, readPlan, writePlan, updateEntries, planPath };
