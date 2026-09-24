import fs from "fs";
import path from "path";

import { normalizeUrl } from "./manifest.js";

/**
 * Per-course content catalog — the index a front-end needs to present a course
 * as a list of things to work through, rather than a tree of folders.
 *
 * One JSON file lives at the root of each course's folder
 * (`<courseDir>/.scrape-catalog.json`). Where the manifest answers "have I
 * downloaded these bytes?", the catalog answers "what items does this course
 * contain, in what order, and where did each one land?":
 *
 *   { id, title, title_safe, category, kind, section, section_ordinal,
 *     ordinal, sort_key, url, dir, grade, due_at, state, files[] }
 *
 * ── Why this is not part of the manifest ──────────────────────────────────
 * The manifest is a download ledger and treats entries as disposable
 * derivatives of remote state: `record()` rebuilds an entry from scratch on
 * every re-download, `reconcile()` under --prune deletes entries outright, and
 * `load()` reads only `assets` and `dirs` so any other top-level key is dropped
 * on the next save. None of that is wrong for a download ledger, and all of it
 * is fatal for an index a user's study plan joins against. The grains differ
 * too: the manifest is one row per downloaded asset, while the catalog's most
 * important rows — an assignment, a module — are items whose primary artifact
 * (ASSIGNMENT.pdf, MODULE.pdf) has no source URL at all.
 *
 * ── The merge rule ────────────────────────────────────────────────────────
 * Items are cumulative; files are per-run truth. A run records the items it
 * saw; on save, items from a category this run did not scrape are carried
 * forward verbatim (so `-a` never erases MODULES), and items in a scraped
 * category that were not seen are flagged `state: "removed"` but kept — their
 * file list included. That asymmetry is what lets --prune delete bytes without
 * deleting the task a user has already ticked off.
 *
 * Like `report` and `manifest`, this is a module-level singleton holding one
 * "current course". That is safe only because scraping is strictly sequential.
 * Every public method swallows its own errors: a catalog bug must never be able
 * to abort a scrape.
 */

const CATALOG_FILE = ".scrape-catalog.json";
const CATALOG_VERSION = 1;

// Display/sort order for the top-level categories, mirroring the PHASES order
// in core/scrape.js. `COURSE` holds the course-level artifacts (HOMEPAGE.pdf)
// and sorts first.
const CATEGORY_RANK = {
  COURSE: 0,
  ASSIGNMENTS: 1,
  MODULES: 2,
  QUIZZES: 3,
  VIDEOS: 4,
  STUDYNET: 5,
};

/** Zero-pads a number so sort_key compares correctly as a plain string. */
function pad(n) {
  return String(Math.max(0, Number(n) || 0)).padStart(4, "0");
}

/**
 * A key that sorts items into the order the instructor laid the course out:
 * category, then section, then position within the section.
 */
function sortKey(category, sectionOrdinal, ordinal) {
  const rank = CATEGORY_RANK[category] ?? 9;
  return `${rank}/${pad(sectionOrdinal)}/${pad(ordinal)}`;
}

/**
 * Path relative to the course folder, with forward slashes.
 *
 * Stored relative for the same reason the manifest does it: a later --wiki or
 * --octarine run relocates the whole course folder, and a relative path travels
 * with it. Forward slashes because this file is read by front-ends, and nothing
 * here needs to split a path to recover the category — that is its own field.
 */
function relFrom(courseDir, absPath) {
  return path.relative(courseDir, absPath).split(path.sep).join("/");
}

/** Extension without the dot, lowercased — "pdf", "mp4", or "" when absent. */
function extOf(p) {
  return (path.extname(p) || "").replace(".", "").toLowerCase();
}

const catalog = {
  // True between load() and reset(), i.e. while a course is current.
  enabled: false,
  courseDir: "",
  course: null,
  // ISO timestamp set at load. Distinguishes items seen this run from ones
  // carried over, the same way manifest.runStart does for assets.
  runStart: "",
  // Items recorded this run, keyed by id, in insertion order.
  seen: new Map(),
  // Items read from the previous catalog, keyed by id.
  prior: new Map(),
  // The item currently being scraped, so file() knows what to attach to.
  open: null,
  // Monotonic counters: item tokens, and the course-wide ordinal.
  _token: 0,
  _seq: 0,

  /**
   * Loads a course's catalog and makes it current. A missing, unreadable, or
   * unrecognized-version file starts empty — deliberately including a *newer*
   * version, which is rebuilt rather than half-read. (The manifest writes a
   * version it never checks; this does not repeat that.)
   * @param {string} courseDir the course's output folder
   * @param {{id?: string, name?: string, url?: string}} [course]
   */
  load(courseDir, course = {}) {
    try {
      this.courseDir = courseDir;
      this.course = {
        id: course.id ? String(course.id) : "",
        name: course.name || "",
        url: course.url || "",
        folder: path.basename(courseDir || ""),
      };
      this.seen = new Map();
      this.prior = new Map();
      this.open = null;
      this._token = 0;
      this._seq = 0;
      this.enabled = true;
      this.runStart = new Date().toISOString();

      const raw = JSON.parse(fs.readFileSync(path.join(courseDir, CATALOG_FILE)));
      if (!raw || raw.version !== CATALOG_VERSION) return; // unknown shape: rebuild
      if (Array.isArray(raw.items)) {
        for (const item of raw.items) {
          if (item && item.id) this.prior.set(item.id, item);
        }
      }
    } catch (e) {
      // No catalog yet, unreadable, or not our version — start fresh.
    }
  },

  /** Clears current-course state. Call after save(), between courses. */
  reset() {
    this.enabled = false;
    this.courseDir = "";
    this.course = null;
    this.runStart = "";
    this.seen = new Map();
    this.prior = new Map();
    this.open = null;
    this._token = 0;
    this._seq = 0;
  },

  /**
   * The catalog id for an item: its normalized Canvas URL.
   *
   * Deliberately the same primitive the manifest keys assets and item folders
   * by, so the two stores agree about identity by construction. It is also the
   * key a study plan joins against, which is why it is imported rather than
   * reimplemented — a divergence here would silently un-tick a user's
   * completed tasks rather than failing loudly.
   * @param {string} url
   * @returns {string}
   */
  key(url) {
    return normalizeUrl(url);
  },

  /** The synthetic item that course-level artifacts (HOMEPAGE.pdf) belong to. */
  _courseItem() {
    const id = `${normalizeUrl(this.course?.url || this.courseDir)}#course`;
    let item = this.seen.get(id);
    if (!item) {
      item = this._blank({
        id,
        title: this.course?.name || this.course?.folder || "Course",
        category: "COURSE",
        kind: "course-home",
        section: "",
        sectionOrdinal: 0,
        ordinal: 0,
        url: this.course?.url || "",
      });
      this.seen.set(id, item);
    }
    return item;
  },

  /** Builds a fresh item record, carrying forward user-invisible prior fields. */
  _blank(spec) {
    const prev = this.prior.get(spec.id);
    return {
      id: spec.id,
      title: spec.title || "",
      title_safe: spec.titleSafe || spec.title || "",
      category: spec.category || "",
      kind: spec.kind || "",
      section: spec.section || "",
      section_ordinal: Number(spec.sectionOrdinal) || 0,
      ordinal: Number(spec.ordinal) || 0,
      sort_key: sortKey(spec.category, spec.sectionOrdinal, spec.ordinal),
      url: spec.url || "",
      dir: spec.dir || (prev && prev.dir) || "",
      grade: spec.grade ?? null,
      due_at: (prev && prev.due_at) || null,
      unlock_at: (prev && prev.unlock_at) || null,
      points_possible: (prev && prev.points_possible) ?? null,
      first_seen: (prev && prev.first_seen) || this.runStart,
      last_seen: this.runStart,
      state: "present",
      files: [],
    };
  },

  /**
   * Opens an item for the duration of its scrape, so files recorded while it is
   * open attach to it. Returns a token that must be handed back to endItem().
   *
   * The token exists because a begin without a matching end would mis-attribute
   * every subsequent file in the run — silently, and plausibly enough to go
   * unnoticed. endItem() verifies it and complains rather than corrupting.
   * @param {object} spec
   * @returns {number|null} token, or null when the catalog is disabled
   */
  beginItem(spec) {
    try {
      if (!this.enabled || !spec || !spec.url) return null;
      const id = this.key(spec.url);
      const item = this._blank({ ...spec, id });
      item.global_ordinal = ++this._seq;
      this.seen.set(id, item);
      this._token = this._token + 1;
      this.open = { token: this._token, id };
      return this._token;
    } catch (e) {
      return null;
    }
  },

  /** Closes the item opened by `token`. Mismatches warn rather than corrupt. */
  endItem(token) {
    try {
      if (!this.enabled || token == null) return;
      if (!this.open || this.open.token !== token) {
        // Not fatal, but it means attribution is off: say so loudly enough to
        // be found in a log, and close nothing rather than close the wrong one.
        console.log(
          "[WARNING] CATALOG | endItem token mismatch — item attribution may be wrong"
        );
        return;
      }
      this.open = null;
    } catch (e) {
      /* never throw into a scrape */
    }
  },

  /**
   * Records the folder an item was written into. Called from mkUniqueDir, so
   * it catches every scraper without each one having to remember.
   * @param {string} absDir
   */
  noteDir(absDir) {
    try {
      if (!this.enabled || !this.open || !absDir) return;
      const item = this.seen.get(this.open.id);
      if (item && !item.dir) item.dir = relFrom(this.courseDir, absDir);
    } catch (e) {
      /* ignore */
    }
  },

  /**
   * Attaches a downloaded file to the open item, or to the course-level item
   * when none is open.
   *
   * Falling back to the course item rather than dropping the file means a
   * mis-attribution degrades to under-attribution: the file is still findable,
   * just filed one level up.
   * @param {string} absPath the file on disk
   * @param {object} [opts]
   * @param {string} [opts.role] page | attachment | submission | comments | media | shortcut
   * @param {string} [opts.url] the source URL, when there is one
   */
  file(absPath, opts = {}) {
    try {
      if (!this.enabled || !absPath) return;
      const item = this.open ? this.seen.get(this.open.id) : this._courseItem();
      if (!item) return;
      const rel = relFrom(this.courseDir, absPath);
      if (item.files.some((f) => f.path === rel)) return; // idempotent
      let bytes = 0;
      try {
        bytes = fs.statSync(absPath).size;
      } catch (e) {
        /* recorded without a size rather than not at all */
      }
      item.files.push({
        path: rel,
        role: opts.role || "attachment",
        type: extOf(absPath),
        bytes,
        url: opts.url || "",
      });
    } catch (e) {
      /* ignore */
    }
  },

  /**
   * Records a standalone item that has no begin/end bracket around it — the
   * Study.Net materials, which are enumerated from an already-rendered list
   * rather than scraped one page at a time.
   * @param {object} spec same shape as beginItem, plus optional `file`
   */
  item(spec) {
    try {
      if (!this.enabled || !spec || !spec.url) return;
      const id = this.key(spec.url);
      const item = this._blank({ ...spec, id });
      item.global_ordinal = ++this._seq;
      this.seen.set(id, item);
      if (spec.file) {
        const rel = relFrom(this.courseDir, spec.file);
        item.files.push({
          path: rel,
          role: spec.role || "attachment",
          type: extOf(spec.file),
          bytes: (() => {
            try {
              return fs.statSync(spec.file).size;
            } catch (e) {
              return 0;
            }
          })(),
          url: spec.sourceUrl || spec.url || "",
        });
      }
    } catch (e) {
      /* ignore */
    }
  },

  /**
   * Registers every media file under a directory as its own item, enumerated
   * from disk.
   *
   * Videos cannot be recorded the way downloads are. yt-dlp's download archive
   * means a second run fetches nothing, so anything driven by a "what appeared
   * this run" diff would list the videos once and then silently lose them. A
   * disk walk gives the same answer on run 1, run 2, and after an interrupt.
   * @param {string} absDir
   * @param {object} opts
   */
  registerTree(absDir, opts = {}) {
    try {
      if (!this.enabled || !absDir || !fs.existsSync(absDir)) return;
      const media = /\.(mp4|m4a|mkv|webm|mp3|wav)$/i;
      const found = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (media.test(entry.name)) found.push(full);
        }
      };
      walk(absDir);
      found.sort((a, b) => a.localeCompare(b));

      found.forEach((full, i) => {
        const rel = relFrom(this.courseDir, full);
        // A playlist folder becomes the section, so a Panopto folder's sessions
        // stay grouped the way the folder presented them.
        const parent = path.basename(path.dirname(full));
        const section = parent === path.basename(absDir) ? "" : parent;
        const id = `${normalizeUrl(opts.sourceUrl || this.course?.url || "")}#${rel}`;
        const item = this._blank({
          id,
          title: path.basename(full, path.extname(full)),
          category: opts.category || "VIDEOS",
          kind: opts.kind || "video",
          section,
          sectionOrdinal: 1,
          ordinal: i + 1,
          url: opts.sourceUrl || "",
        });
        item.global_ordinal = ++this._seq;
        item.dir = relFrom(this.courseDir, path.dirname(full));
        let bytes = 0;
        try {
          bytes = fs.statSync(full).size;
        } catch (e) {
          /* ignore */
        }
        item.files.push({
          path: rel,
          role: "media",
          type: extOf(full),
          bytes,
          url: opts.sourceUrl || "",
        });
        this.seen.set(id, item);
      });
    } catch (e) {
      /* ignore */
    }
  },

  /**
   * Enriches items with Canvas dates, keyed by normalized URL.
   * @param {Map<string, {due_at?: string, unlock_at?: string, points_possible?: number}>} map
   */
  applyDates(map) {
    try {
      if (!this.enabled || !map || !map.size) return;
      for (const item of this.seen.values()) {
        const hit = map.get(item.id);
        if (!hit) continue;
        item.due_at = hit.due_at || null;
        item.unlock_at = hit.unlock_at || null;
        item.points_possible = hit.points_possible ?? null;
        item.dates_source = "api:assignments";
      }
    } catch (e) {
      /* ignore */
    }
  },

  /**
   * Merges the previous catalog into this run's, scoped to the categories this
   * run actually scraped.
   *
   * Without the scoping an `-a` run would erase every MODULES task recorded a
   * week earlier — the same hazard, and the same guard, as manifest.reconcile.
   * @param {Set<string>} [categories] top-level category names scraped this run
   * @returns {{carried: number, removed: number}}
   */
  reconcile(categories = null) {
    const result = { carried: 0, removed: 0 };
    try {
      if (!this.enabled) return result;
      for (const [id, prev] of this.prior) {
        if (this.seen.has(id)) continue;
        const scoped = categories && categories.size;
        if (scoped && !categories.has(prev.category)) {
          this.seen.set(id, prev); // category not scraped this run — keep as-is
          result.carried++;
          continue;
        }
        // In a scraped category and not seen: the source is gone from the
        // course. Keep the item and its files so a completed task survives.
        this.seen.set(id, { ...prev, state: "removed" });
        result.removed++;
      }
    } catch (e) {
      /* ignore */
    }
    return result;
  },

  /** Persists to `<courseDir>/.scrape-catalog.json` (atomic). */
  save() {
    try {
      if (!this.enabled || !this.courseDir) return;
      const items = [...this.seen.values()].sort((a, b) =>
        a.sort_key === b.sort_key
          ? (a.global_ordinal || 0) - (b.global_ordinal || 0)
          : a.sort_key.localeCompare(b.sort_key)
      );
      const out = {
        version: CATALOG_VERSION,
        course: this.course,
        generated: new Date().toISOString(),
        run_start: this.runStart,
        items,
      };
      const dest = path.join(this.courseDir, CATALOG_FILE);
      const tmp = dest + ".part";
      try {
        fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
        fs.renameSync(tmp, dest); // atomic — never a half-written catalog
      } catch (e) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch (e2) {
          /* ignore */
        }
      }
    } catch (e) {
      /* ignore */
    }
  },
};

export { CATALOG_FILE, CATALOG_VERSION, sortKey };
export default catalog;
