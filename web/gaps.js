import fs from "fs";
import path from "path";

import {
  readWorklist,
  listDroppedFiles,
  readImportLog,
  gapLabel,
  parseCsv,
  runImport,
} from "../core/import.js";

/**
 * The gaps worklist, and filing a manually-obtained file into one.
 *
 * Some course material cannot be pulled automatically but is trivially
 * obtained by hand — the clearest case being Harvard Business Publishing
 * readings behind a Canvas LTI launch, which open fine in a browser and fail
 * the headless download. The scraper already records those in
 * report-skipped.csv with the folder it would have saved into; all that was
 * missing was somewhere to do something about them.
 */

/** The folder dropped files land in, which is also what the CLI importer uses. */
export function dropDir(root) {
  return path.join(root, "import");
}

/** Reads the worklist, the files already dropped, and what has been imported. */
export function readGaps(root) {
  let rows = [];
  try {
    rows = readWorklist(root);
  } catch (e) {
    return { root, error: e.message, gaps: [], dropped: [], imported: 0 };
  }
  const log = readImportLog(path.join(dropDir(root), "imported.log.jsonl"));
  const done = new Set(log.map((e) => e.url));

  const gaps = rows.map((r) => ({
    url: r.url,
    label: gapLabel(r),
    reason: r.reason || "",
    destDir: r.destDir || "",
    courseName: r.courseName || "",
    courseUrl: r.courseUrl || "",
    source: r.source || "",
    imported: done.has(r.url),
    // Worth distinguishing: a paywall or a licensed database is not something
    // a re-run or a dropped file will ever fix, whereas an LTI launch is
    // exactly what this screen exists for.
    recoverable: !/paywall|library-licensed|subscription/i.test(r.reason || ""),
  }));

  return {
    root,
    gaps,
    dropped: listDroppedFiles(dropDir(root)),
    imported: log.length,
    dropPath: dropDir(root),
  };
}

/**
 * Stores an uploaded file in the drop folder.
 *
 * The browser hands over bytes, not paths, so the file is written here — which
 * also means no multipart parser and no new dependency, since a single file
 * can just be the request body.
 */
export function saveDropped(root, name, buffer) {
  // The name comes from a browser file picker, so take the basename and
  // nothing else: it must not be able to escape the drop folder.
  const safe = path.basename(String(name || "").trim());
  if (!safe || safe.startsWith(".")) throw new Error("bad file name");
  const dir = dropDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safe);
  fs.writeFileSync(dest, buffer);
  return { name: safe, path: dest, bytes: buffer.length };
}

/** Removes a dropped file that was never matched. */
export function removeDropped(root, name) {
  const safe = path.basename(String(name || "").trim());
  if (!safe) throw new Error("bad file name");
  fs.rmSync(path.join(dropDir(root), safe), { force: true });
  return { ok: true };
}

/**
 * Files the dropped files into the gaps they were matched to.
 *
 * The matching happens in the browser, so the manifest is written here and the
 * importer runs non-interactively — which sidesteps the CLI's stdin prompt
 * entirely rather than trying to drive it.
 */
export async function applyImports(root, mappings, { dryRun = false } = {}) {
  const dir = dropDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      mappings.map((m) => ({ file: path.basename(m.file), url: m.url })),
      null,
      2
    )
  );
  return runImport(root, { manifest: manifestPath, dir, dryRun, interactive: false }, {});
}

/** The dry-run accessibility report, parsed. */
export function readDryRun(root) {
  const file = path.join(root, "dry-run-report.csv");
  if (!fs.existsSync(file)) return { root, exists: false, rows: [] };
  let rows = [];
  try {
    rows = parseCsv(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { root, exists: true, error: e.message, rows: [] };
  }
  const mapped = rows.map((r) => ({
    status: r.status || "",
    kind: r.kind || "",
    url: r.url || "",
    reason: r.reason || "",
    courseName: r.course_name || "",
  }));
  let updated = null;
  try {
    updated = fs.statSync(file).mtime.toISOString();
  } catch (e) {
    /* ignore */
  }
  return {
    root,
    exists: true,
    updated,
    rows: mapped,
    accessible: mapped.filter((r) => r.status === "accessible").length,
    inaccessible: mapped.filter((r) => r.status === "inaccessible").length,
  };
}

export default { readGaps, saveDropped, removeDropped, applyImports, readDryRun, dropDir };
