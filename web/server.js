import http from "http";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";

import { readAsset, contentType, isInlined } from "./assets.js";
import { readLibrary } from "./library.js";
import { readSessions } from "./sessions.js";
import { openPath, openUrl } from "./opener.js";
import { findChrome, chromeInstallInstructions } from "../core/chrome.js";

/**
 * The local web app's HTTP server.
 *
 * ── Security posture ──────────────────────────────────────────────────────
 * This server can open files on the machine it runs on, so it is treated as
 * privileged even though it never leaves the loopback interface:
 *
 *  - It binds 127.0.0.1 only. There is no --host flag, deliberately.
 *  - Every /api call must carry a per-launch token in a custom header. A
 *    custom header cannot be set by a cross-origin form or an <img>, so this
 *    is CSRF defence as much as authentication. The token is held in memory
 *    and never written to disk.
 *  - The Host header is checked against an allowlist. This, not the bind
 *    address, is what actually stops DNS rebinding: a hostile page can
 *    resolve its own domain to 127.0.0.1, and only the Host check notices.
 *  - The Origin is checked on mutating requests.
 *  - Referrer-Policy: no-referrer, because the page URL briefly carries the
 *    token and outbound Canvas links would otherwise hand it to the
 *    university's server in a Referer header.
 *  - There is no generic file-read route. /api/open hands a path to the OS
 *    opener after confirming it resolves inside a known archive root, and
 *    never returns bytes.
 */

const DEFAULT_PORT = 7373;

/** Response headers applied to everything this server returns. */
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/** Settings live beside the user's other app data, never in the cwd. */
export function settingsDir() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "canvas-scraper");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "canvas-scraper");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "canvas-scraper");
}

const SETTINGS_FILE = () => path.join(settingsDir(), "settings.json");

/** Reads persisted settings, falling back to defaults. */
export function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch (e) {
    /* first run */
  }
  return {};
}

/** Persists settings, merging over what is already there. */
export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(settingsDir(), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2));
  } catch (e) {
    /* best-effort: the app works without persisted settings */
  }
  return next;
}

/** Sends a JSON body. */
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

/** Reads a JSON request body, with a size ceiling. */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Starts the server.
 * @param {object} opts
 * @param {number} [opts.port]
 * @param {string} [opts.output] seed for the archive root
 * @param {string} [opts.cookies] seed for the cookies path
 * @returns {Promise<{url: string, port: number, token: string, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const settings = readSettings();

  // Roots the app may read and open from. Seeded by --output and by whatever
  // the user has opened before; /api/open refuses anything outside them.
  const roots = new Set();
  const addRoot = (p) => {
    if (!p) return;
    try {
      roots.add(path.resolve(p));
    } catch (e) {
      /* ignore */
    }
  };
  addRoot(opts.output || settings.defaultRoot || "courses");
  for (const r of settings.recentRoots || []) addRoot(r);

  const state = {
    cookiesPath: path.resolve(opts.cookies || settings.cookiesPath || "cookies.json"),
    configPath: path.resolve(opts.config || "config.json"),
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch (e) {
      return sendJson(res, 400, { error: "bad request" });
    }
    const pathname = url.pathname;

    // DNS-rebinding defence: a hostile page can point its own hostname at
    // 127.0.0.1, and only the Host header gives it away.
    const host = String(req.headers.host || "");
    const hostOk = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);
    if (!hostOk) return sendJson(res, 403, { error: "bad host" });

    const isApi = pathname.startsWith("/api/");
    if (isApi) {
      if (req.headers["x-cs-token"] !== token) {
        return sendJson(res, 401, { error: "bad token" });
      }
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) {
          return sendJson(res, 403, { error: "bad origin" });
        }
      }
    }

    try {
      if (isApi) return await handleApi(req, res, { pathname, state, roots, addRoot, token, server });
      return serveStatic(res, pathname);
    } catch (e) {
      return sendJson(res, 500, { error: e.message || String(e) });
    }
  });

  const port = await listen(server, opts.port || DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  return {
    url,
    port,
    token,
    roots: [...roots],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Listens on `preferred`, falling back to an ephemeral port when it is taken. */
function listen(server, preferred) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
        return;
      }
      reject(err);
    };
    server.once("error", onError);
    server.listen(preferred, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** Serves the browser app. Unknown paths fall through to the SPA shell. */
function serveStatic(res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  let body = readAsset(name);
  let asset = name;
  if (!body) {
    // Client-side routes (/library, /sessions) are not files.
    body = readAsset("index.html");
    asset = "index.html";
  }
  if (!body) {
    res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": contentType(asset),
    "Content-Length": body.length,
  });
  res.end(body);
}

/** The JSON API. */
async function handleApi(req, res, ctx) {
  const { pathname, state, roots, addRoot, server } = ctx;
  const url = new URL(req.url, "http://127.0.0.1");

  if (pathname === "/api/state" && req.method === "GET") {
    const chrome = findChrome();
    return sendJson(res, 200, {
      version: 1,
      platform: process.platform,
      node: process.version,
      packaged: isInlined(),
      chrome: {
        found: !!chrome,
        path: chrome || null,
        // Only computed when missing — it is install advice, not status.
        instructions: chrome ? null : safeChromeInstructions(),
      },
      cookiesPath: state.cookiesPath,
      roots: [...roots],
      settings: readSettings(),
    });
  }

  if (pathname === "/api/settings" && req.method === "PUT") {
    const patch = await readBody(req);
    const allowed = {};
    for (const k of ["defaultRoot", "recentRoots", "cookiesPath"]) {
      if (k in patch) allowed[k] = patch[k];
    }
    if (allowed.defaultRoot) addRoot(allowed.defaultRoot);
    return sendJson(res, 200, writeSettings(allowed));
  }

  if (pathname === "/api/library" && req.method === "GET") {
    const root = path.resolve(url.searchParams.get("root") || [...roots][0] || "courses");
    addRoot(root);
    return sendJson(res, 200, readLibrary(root));
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    const cookies = url.searchParams.get("cookies");
    const p = cookies ? path.resolve(cookies) : state.cookiesPath;
    return sendJson(res, 200, readSessions(p, state.configPath));
  }

  if (pathname === "/api/open" && req.method === "POST") {
    const body = await readBody(req);
    if (body.url) {
      const r = openUrl(body.url);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (body.path) {
      const r = openPath(body.path, [...roots]);
      return sendJson(res, r.ok ? 200 : 403, r);
    }
    return sendJson(res, 400, { error: "path or url required" });
  }

  if (pathname === "/api/shutdown" && req.method === "POST") {
    sendJson(res, 200, { ok: true });
    setTimeout(() => {
      server.close(() => process.exit(0));
      server.closeAllConnections?.();
    }, 50);
    return undefined;
  }

  return sendJson(res, 404, { error: "no such endpoint" });
}

/** chromeInstallInstructions() is advisory; never let it break /api/state. */
function safeChromeInstructions() {
  try {
    return chromeInstallInstructions();
  } catch (e) {
    return null;
  }
}

export default { startServer, readSettings, writeSettings, settingsDir };
