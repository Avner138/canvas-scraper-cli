import fs from "fs";
import os from "os";
import path from "path";

/**
 * Directory browsing and destination suggestions for the folder picker.
 *
 * The browser cannot pick a folder for us. `showDirectoryPicker()` is not just
 * Chromium-only — it hands back a handle whose absolute path is deliberately
 * unobtainable, and the scraper needs a real path for --output. So the picker
 * is served from here, which also keeps the app working identically in Safari
 * and Firefox.
 *
 * This lists directory *names* only and never returns file bytes. It
 * deliberately allows browsing outside the registered archive roots, because
 * choosing a new archive means naming a folder the app has never seen —
 * whereas /api/open stays restricted to the roots, since opening a file is a
 * different power from seeing that a folder exists.
 */

/** Free space and writability for a directory, best-effort. */
function volumeInfo(dir) {
  const out = { writable: false, freeBytes: null };
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    out.writable = true;
  } catch (e) {
    /* not writable, or gone */
  }
  try {
    const st = fs.statfsSync(dir);
    out.freeBytes = st.bavail * st.bsize;
  } catch (e) {
    /* statfs is unavailable on some platforms/mounts */
  }
  return out;
}

/** First existing match for a glob-ish prefix inside a parent directory. */
function matchingDirs(parent, startsWith) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(startsWith))
      .map((e) => path.join(parent, e.name));
  } catch (e) {
    return [];
  }
}

/**
 * Candidate cloud-sync folders for this platform.
 *
 * Each provider has moved its folder at least once, so both the modern and the
 * legacy location are probed. Linux coverage is genuinely weak — there is no
 * standard location and Drive has no official client — so the free-text path
 * box carries that platform.
 */
export function cloudRoots() {
  const home = os.homedir();
  const out = [];
  const add = (dir, label) => {
    if (dir && fs.existsSync(dir)) out.push({ path: dir, label, kind: "cloud" });
  };

  if (process.platform === "darwin") {
    const cs = path.join(home, "Library", "CloudStorage");
    for (const d of matchingDirs(cs, "GoogleDrive-")) add(d, "Google Drive");
    for (const d of matchingDirs(cs, "OneDrive-")) add(d, "OneDrive");
    for (const d of matchingDirs(cs, "Dropbox")) add(d, "Dropbox");
    add(path.join(home, "Google Drive"), "Google Drive");
    add(path.join(home, "OneDrive"), "OneDrive");
    add(path.join(home, "Dropbox"), "Dropbox");
    add(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), "iCloud Drive");
  } else if (process.platform === "win32") {
    for (const key of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]) {
      add(process.env[key], "OneDrive");
    }
    // Dropbox records its real location, which the user may have moved.
    try {
      const info = path.join(process.env.LOCALAPPDATA || "", "Dropbox", "info.json");
      const raw = JSON.parse(fs.readFileSync(info, "utf8"));
      for (const k of ["personal", "business"]) {
        if (raw[k]?.path) add(raw[k].path, "Dropbox");
      }
    } catch (e) {
      /* no Dropbox */
    }
    add(path.join(home, "Google Drive"), "Google Drive");
  } else {
    add(path.join(home, "Dropbox"), "Dropbox");
    add(path.join(home, "OneDrive"), "OneDrive");
    add(path.join(home, "GoogleDrive"), "Google Drive");
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(home, ".dropbox", "info.json"), "utf8"));
      for (const k of ["personal", "business"]) {
        if (raw[k]?.path) add(raw[k].path, "Dropbox");
      }
    } catch (e) {
      /* no Dropbox */
    }
  }

  // De-duplicate: the modern and legacy probes can both hit, and on macOS a
  // legacy path is often a symlink to the CloudStorage one.
  const seen = new Set();
  return out.filter((r) => {
    let real = r.path;
    try {
      real = fs.realpathSync(r.path);
    } catch (e) {
      /* keep the raw path */
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/**
 * Places worth offering as a destination: the usual home folders, then any
 * detected cloud-sync folder.
 */
export function suggestions(extra = []) {
  const home = os.homedir();
  const base = [
    { path: home, label: "Home", kind: "home" },
    { path: path.join(home, "Documents"), label: "Documents", kind: "home" },
    { path: path.join(home, "Desktop"), label: "Desktop", kind: "home" },
  ].filter((s) => fs.existsSync(s.path));

  const recents = (extra || [])
    .filter((p) => p && fs.existsSync(p))
    .map((p) => ({ path: p, label: path.basename(p) || p, kind: "recent" }));

  const all = [...recents, ...base, ...cloudRoots()];
  const seen = new Set();
  return all
    .filter((s) => {
      if (seen.has(s.path)) return false;
      seen.add(s.path);
      return true;
    })
    .map((s) => ({ ...s, ...volumeInfo(s.path), warning: warningFor(s) }));
}

/**
 * The one warning worth showing on a cloud destination.
 *
 * On a streaming-only mount (Drive File Stream, OneDrive Files On-Demand) a
 * file can be a placeholder whose size on disk does not match what was
 * downloaded. manifest.completePath() compares stat.size against the recorded
 * byte count and re-downloads on a mismatch, so a badly-behaved placeholder
 * turns every re-run into a full re-download of the whole archive.
 */
function warningFor(s) {
  if (s.kind !== "cloud") return null;
  return "Cloud folder — set it to keep files available offline, or every re-run may re-download everything.";
}

/** Lists the subdirectories of a path, for the in-app browser. */
export function listDir(target) {
  const dir = path.resolve(target || os.homedir());
  const out = {
    path: dir,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    dirs: [],
    exists: fs.existsSync(dir),
    ...volumeInfo(dir),
  };
  if (!out.exists) return out;
  try {
    out.dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    out.error = e.code === "EACCES" ? "not permitted" : e.message;
  }
  return out;
}

/**
 * Checks a path is usable as an archive destination.
 *
 * A folder that does not exist yet is fine — the scraper creates it — as long
 * as the nearest existing ancestor is writable. Saying "no such folder" for a
 * path someone is about to create would be unhelpful.
 */
export function validate(target) {
  // Checked before resolving: path.resolve("") returns the working directory,
  // so an empty box would otherwise validate clean and silently adopt whatever
  // folder the app happened to be launched from.
  const raw = String(target || "").trim();
  if (!raw) return { path: "", exists: false, ok: false, warnings: [], error: "enter a folder path" };

  const dir = path.resolve(raw);
  const out = { path: dir, exists: fs.existsSync(dir), ok: false, warnings: [] };

  let probe = dir;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  const info = volumeInfo(probe);
  out.writable = info.writable;
  out.freeBytes = info.freeBytes;

  if (!info.writable) {
    out.error = out.exists ? "not writable" : `cannot create: ${probe} is not writable`;
    return out;
  }
  if (out.exists) {
    try {
      const entries = fs.readdirSync(dir);
      out.isEmpty = entries.length === 0;
      out.hasCourses = entries.some((e) =>
        fs.existsSync(path.join(dir, e, ".scrape-manifest.json"))
      );
    } catch (e) {
      out.error = "cannot read that folder";
      return out;
    }
  } else {
    out.willCreate = true;
  }

  const cloud = cloudRoots().find(
    (c) => dir === c.path || dir.startsWith(c.path + path.sep)
  );
  if (cloud) out.warnings.push(warningFor(cloud));
  if (out.freeBytes !== null && out.freeBytes < 2 * 1024 ** 3) {
    out.warnings.push("Less than 2 GB free — a course with videos can exceed that.");
  }
  out.ok = true;
  return out;
}

export default { suggestions, cloudRoots, listDir, validate };
