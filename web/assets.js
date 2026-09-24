import fs from "fs";
import path from "path";

/**
 * Serves the browser app's static files, from disk in development and from an
 * inlined map in the packaged binary.
 *
 * build.mjs bundles everything into one ESM file, so at runtime
 * `import.meta.url` points at `dist/app.mjs` and `./public/index.html` does not
 * exist beside it. pkg's own `assets` mechanism cannot help either: it scans
 * for static `path.join(__dirname, …)` patterns, and esbuild has already
 * erased those by the time pkg sees the bundle.
 *
 * So the bundle inlines the files instead. The esbuild plugin in build.mjs
 * replaces the `INLINED` constant below with a base64 map of `web/public`.
 * Running from source leaves it null and reads live files, which keeps the
 * edit-and-reload loop intact.
 */

// Replaced at bundle time by the inline-web-assets plugin in build.mjs.
const INLINED = null;

/** Media types for the handful of extensions this app actually ships. */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Whether the app is running from an inlined bundle rather than source. */
export function isInlined() {
  return !!INLINED;
}

/** The media type for an asset name, defaulting to octet-stream. */
export function contentType(name) {
  return TYPES[path.extname(name).toLowerCase()] || "application/octet-stream";
}

/**
 * Reads a static asset by name.
 *
 * `name` always comes from the server's own route table, never from a request
 * path, so there is no traversal surface here — but the leading-dot and `..`
 * rejection stays as a second line of defence in case that ever changes.
 * @param {string} name e.g. "index.html" or "screens/library.js"
 * @returns {Buffer|null} the bytes, or null when there is no such asset
 */
export function readAsset(name) {
  if (!name || name.includes("..") || name.startsWith("/")) return null;
  try {
    if (INLINED) {
      const b64 = INLINED[name];
      return b64 ? Buffer.from(b64, "base64") : null;
    }
    return fs.readFileSync(new URL(`./public/${name}`, import.meta.url));
  } catch (e) {
    return null;
  }
}

/** Every asset name this build can serve. */
export function assetNames() {
  if (INLINED) return Object.keys(INLINED);
  const root = new URL("./public/", import.meta.url);
  const dir = decodeURIComponent(root.pathname);
  const out = [];
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  try {
    walk("");
  } catch (e) {
    /* no public dir (shouldn't happen from source) */
  }
  return out;
}

export default { readAsset, assetNames, contentType, isInlined };
