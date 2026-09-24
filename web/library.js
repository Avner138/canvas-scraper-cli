import fs from "fs";
import path from "path";

import { MANIFEST_FILE } from "../scrapers/manifest.js";
import { CATALOG_FILE } from "../scrapers/catalog.js";
import { detectLayout, parseCsv } from "../core/import.js";

/**
 * Reads an archive back off disk as an inventory.
 *
 * Everything here is derived from files the scraper already writes — the
 * per-course manifest, and the run-level report CSVs. Nothing is recomputed by
 * walking the tree, because the manifest already knows which assets are
 * complete, which are truncated, and which have gone from the course.
 */

/** Reads a JSON file, or returns null. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

/** Reads a CSV written by scrapers/report.js into row objects, or []. */
function readCsv(file) {
  try {
    return parseCsv(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return [];
  }
}

/**
 * Counts the real files under a course folder.
 *
 * The manifest is the source of truth for what a resume will skip, but it is
 * not a complete picture of what was downloaded: Study.Net materials, the page
 * PDFs (HOMEPAGE/ASSIGNMENT/MODULE/QUIZ), webpage archives, HBSP LTI PDFs and
 * videos are all written without a manifest record. Counting the disk as well
 * makes that gap visible instead of reporting a folder full of PDFs as empty —
 * and the gap matters, because an untracked file is re-downloaded every run.
 */
function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // manifest, catalog, .part files
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch (e) {
          /* counted without a size */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** A short human size, matching the convention used elsewhere in the project. */
export function humanSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/**
 * Summarizes one course folder from its manifest.
 *
 * The four states are deliberately distinct, because they mean different
 * things to someone deciding whether to re-scrape:
 *   complete   — downloaded, and the file on disk is the size we recorded
 *   incomplete — recorded but truncated or never finished
 *   removed    — gone from the course; the local copy is kept (see --prune)
 *   missing    — the manifest says complete, but the file is not on disk
 */
export function readCourse(courseDir) {
  const manifest = readJson(path.join(courseDir, MANIFEST_FILE));
  const catalog = readJson(path.join(courseDir, CATALOG_FILE));
  const folder = path.basename(courseDir);

  const disk = countFiles(courseDir);
  const out = {
    folder,
    dir: courseDir,
    name: catalog?.course?.name || folder,
    url: catalog?.course?.url || manifest?.course_url || "",
    updated: manifest?.updated || null,
    indexed: !!catalog,
    itemCount: catalog?.items?.length ?? null,
    assets: 0,
    complete: 0,
    incomplete: 0,
    removed: 0,
    missing: 0,
    bytes: 0,
    filesOnDisk: disk.files,
    bytesOnDisk: disk.bytes,
    untracked: 0,
    hasHomepage: fs.existsSync(path.join(courseDir, "HOMEPAGE.pdf")),
  };

  const assets = manifest?.assets;
  if (!assets || typeof assets !== "object") {
    out.untracked = disk.files;
    return out;
  }

  for (const entry of Object.values(assets)) {
    if (!entry || !entry.path) continue;
    out.assets++;
    out.bytes += Number(entry.bytes) || 0;
    if (entry.state === "removed") {
      out.removed++;
      continue;
    }
    if (!entry.complete) {
      out.incomplete++;
      continue;
    }
    // A complete entry whose file has since gone is worth surfacing — it is
    // the signature of a cloud-sync placeholder or a manual delete, and it is
    // what makes the next run re-download.
    if (!fs.existsSync(path.join(courseDir, entry.path))) out.missing++;
    else out.complete++;
  }
  // Files the manifest has no entry for at all. Not corruption — several
  // download paths simply never record one — but they are re-fetched on every
  // run, so it is worth showing.
  out.untracked = Math.max(0, disk.files - (out.assets - out.removed - out.missing));
  return out;
}

/**
 * Lists the course folders inside an archive root, following the subdirectory
 * a --wiki or --octarine run relocated them into.
 * @param {string} root the output directory
 */
export function listCourseDirs(root) {
  const layout = detectLayout(root);
  const base = layout.subdir ? path.join(root, layout.subdir) : root;
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (e) {
    return { layout, dirs: [] };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(base, e.name))
    // A course folder is one that a scrape wrote a manifest into. This is what
    // keeps `import/`, `wiki/` and other siblings out of the course list.
    .filter((d) => fs.existsSync(path.join(d, MANIFEST_FILE)));
  return { layout, dirs };
}

/**
 * The whole archive at `root`: its layout, its courses, and the run-level
 * reports that describe what the last scrape could not get.
 * @param {string} root
 */
export function readLibrary(root) {
  const { layout, dirs } = listCourseDirs(root);
  const courses = dirs.map(readCourse);

  const skipped = readCsv(path.join(root, "report-skipped.csv"));
  const errors = readCsv(path.join(root, "errors.csv"));
  const dryRun = readCsv(path.join(root, "dry-run-report.csv"));

  const totals = courses.reduce(
    (acc, c) => {
      acc.assets += c.assets;
      acc.complete += c.complete;
      acc.incomplete += c.incomplete;
      acc.removed += c.removed;
      acc.missing += c.missing;
      acc.bytes += c.bytes;
      acc.filesOnDisk += c.filesOnDisk;
      acc.bytesOnDisk += c.bytesOnDisk;
      acc.untracked += c.untracked;
      return acc;
    },
    {
      assets: 0, complete: 0, incomplete: 0, removed: 0, missing: 0,
      bytes: 0, filesOnDisk: 0, bytesOnDisk: 0, untracked: 0,
    }
  );

  return {
    root,
    exists: fs.existsSync(root),
    layout: layout.kind,
    courses,
    totals: {
      ...totals,
      bytesHuman: humanSize(totals.bytes),
      bytesOnDiskHuman: humanSize(totals.bytesOnDisk),
      courses: courses.length,
    },
    reports: {
      // errors.csv is not overwritten by a clean run, so its mtime is the only
      // honest way to say whether it describes the latest one.
      skipped: skipped.length,
      errors: errors.length,
      errorsUpdated: statTime(path.join(root, "errors.csv")),
      dryRun: dryRun.length,
      dryRunUpdated: statTime(path.join(root, "dry-run-report.csv")),
    },
  };
}

/** An ISO mtime for a file, or null. */
function statTime(file) {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch (e) {
    return null;
  }
}

export default { readLibrary, readCourse, listCourseDirs, humanSize };
