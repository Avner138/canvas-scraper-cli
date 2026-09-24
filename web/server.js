import http from "http";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";

import { readAsset, contentType, isInlined } from "./assets.js";
import { readLibrary } from "./library.js";
import { readSessions } from "./sessions.js";
import { openPath, openUrl } from "./opener.js";
import { suggestions, listDir, validate } from "./fsbrowse.js";
import { JobRunner } from "./jobs.js";
import {
  readGaps,
  saveDropped,
  removeDropped,
  applyImports,
  readDryRun,
} from "./gaps.js";
import { loadStudyList, updateEntries } from "../core/plan.js";
import { buildSchedule, ratePerDay, summarize, tomorrow } from "../core/schedule.js";
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

/** Reads a raw request body, with a size ceiling. */
function readRaw(req, limit = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("file too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

  const runner = new JobRunner();

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
      // /api/events is the one route authenticated by query string instead of
      // header, because EventSource cannot set headers. It checks the token
      // itself; exempting it here is what lets that check ever run.
      const headerExempt = pathname === "/api/events";
      if (!headerExempt && req.headers["x-cs-token"] !== token) {
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
      if (isApi) {
        return await handleApi(req, res, {
          pathname, state, roots, addRoot, token, server, runner,
        });
      }
      return serveStatic(res, pathname, token);
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
function serveStatic(res, pathname, token) {
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
  if (asset === "index.html") {
    // The shell carries the token, so opening the bare URL works — which is
    // what a dev-server wrapper or a bookmark does. The request has already
    // passed the Host allowlist, and no other origin can read this body.
    // Cache-Control is no-store for everything here, so it is never stored.
    body = Buffer.from(body.toString("utf8").replace("__CS_TOKEN__", token));
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
  const { pathname, state, roots, addRoot, server, runner, token } = ctx;
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
    const root = path.resolve(
      url.searchParams.get("root") || readSettings().defaultRoot || [...roots][0] || "courses"
    );
    addRoot(root);
    return sendJson(res, 200, readLibrary(root));
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    const cookies = url.searchParams.get("cookies");
    const p = cookies ? path.resolve(cookies) : state.cookiesPath;
    return sendJson(res, 200, readSessions(p, state.configPath));
  }

  // Folder picking. These deliberately reach outside the registered roots:
  // choosing a new archive means naming a folder the app has never seen. They
  // return directory names only, never file contents.
  // Live progress. One multiplexed stream rather than one per screen: HTTP/1.1
  // allows six connections per origin, and a nine-minute scrape outlives any
  // single screen. SSE rather than a WebSocket because it is res.write() on
  // the server we already have — no new runtime dependency to survive esbuild
  // and pkg, which this project has been burned by before.
  if (pathname === "/api/events" && req.method === "GET") {
    // EventSource cannot set headers, so this one route takes the token from
    // the query string. Loopback-only, no-store, no-referrer.
    if (url.searchParams.get("token") !== token) {
      return sendJson(res, 401, { error: "bad token" });
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ active: runner.active })}\n\n`);

    // Coalesced: streamToFile emits every 150ms per download and yt-dlp can be
    // faster. Sending each one straight through would flood the page for no
    // extra information.
    let pending = null;
    let timer = null;
    const flush = () => {
      timer = null;
      if (!pending) return;
      const batch = pending;
      pending = null;
      try {
        res.write(`id: ${batch.seq}\ndata: ${JSON.stringify(batch)}\n\n`);
      } catch (e) {
        /* the client went away */
      }
    };
    const unsubscribe = runner.subscribe((event) => {
      // Logs and job transitions go immediately; byte progress is throttled.
      if (event.type === "progress") {
        pending = event;
        if (!timer) timer = setTimeout(flush, 200);
        return;
      }
      try {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch (e) {
        /* the client went away */
      }
    });
    // A comment every 15s keeps the connection warm and reveals a dead client.
    const keepalive = setInterval(() => {
      try {
        res.write(":ka\n\n");
      } catch (e) {
        /* ignore */
      }
    }, 15000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(keepalive);
      if (timer) clearTimeout(timer);
    });
    return undefined;
  }

  if (pathname === "/api/jobs" && req.method === "GET") {
    return sendJson(res, 200, { jobs: runner.list(), active: runner.active });
  }

  if (pathname === "/api/jobs" && req.method === "POST") {
    const body = await readBody(req);
    const spec = buildJobSpec(body, state, roots, addRoot);
    if (spec.error) return sendJson(res, 400, { error: spec.error });
    const r = runner.start(spec);
    // Refused rather than queued: the scrapers keep per-run state in
    // module-level singletons, so two at once would corrupt each other.
    if (r.busy) {
      return sendJson(res, 409, { error: "a job is already running", active: r.busy });
    }
    return sendJson(res, 201, { id: r.id, job: runner.get(r.id) });
  }

  const jobMatch = /^\/api\/jobs\/([A-Za-z0-9-]+)(\/[a-z-]+)?(\/.+)?$/.exec(pathname);
  if (jobMatch) {
    const [, id, action] = jobMatch;
    if (!action && req.method === "GET") {
      const job = runner.get(id);
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: "no such job" });
    }
    if (action === "/log" && req.method === "GET") {
      const after = parseInt(url.searchParams.get("after") || "0", 10) || 0;
      return sendJson(res, 200, { records: runner.logSlice(id, after) });
    }
    if (action === "/cancel" && req.method === "POST") {
      return sendJson(res, 200, { ok: runner.cancel(id) });
    }
    if (action === "/prompt" && req.method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: runner.reply(id, body.promptId) });
    }
  }

  if (pathname === "/api/fs/suggestions" && req.method === "GET") {
    const settings = readSettings();
    return sendJson(res, 200, {
      suggestions: suggestions([settings.defaultRoot, ...(settings.recentRoots || [])]),
    });
  }

  if (pathname === "/api/fs/list" && req.method === "GET") {
    return sendJson(res, 200, listDir(url.searchParams.get("path") || ""));
  }

  if (pathname === "/api/fs/validate" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, validate(body.path || ""));
  }

  // Remembers a chosen archive: the default, plus a short recents list so
  // "specify a path every time" does not mean retyping it every time.
  if (pathname === "/api/fs/use" && req.method === "POST") {
    const body = await readBody(req);
    const chosen = path.resolve(body.path || "");
    const check = validate(chosen);
    if (!check.ok) return sendJson(res, 400, check);
    addRoot(chosen);
    const settings = readSettings();
    const recents = [chosen, ...(settings.recentRoots || []).filter((r) => r !== chosen)];
    writeSettings({
      recentRoots: recents.slice(0, 8),
      ...(body.makeDefault ? { defaultRoot: chosen } : {}),
    });
    return sendJson(res, 200, { ok: true, path: chosen, ...check });
  }

  if (pathname === "/api/gaps" && req.method === "GET") {
    const root = path.resolve(
      url.searchParams.get("root") || readSettings().defaultRoot || [...roots][0] || "courses"
    );
    addRoot(root);
    return sendJson(res, 200, readGaps(root));
  }

  // The browser has bytes, not a path, so a dropped file is uploaded as the
  // raw request body — no multipart parser, no new dependency.
  if (pathname === "/api/gaps/file" && req.method === "PUT") {
    const root = path.resolve(
      url.searchParams.get("root") || readSettings().defaultRoot || [...roots][0] || "courses"
    );
    addRoot(root);
    try {
      const buf = await readRaw(req);
      return sendJson(res, 200, saveDropped(root, url.searchParams.get("name"), buf));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === "/api/gaps/file" && req.method === "DELETE") {
    const root = path.resolve(
      url.searchParams.get("root") || readSettings().defaultRoot || [...roots][0] || "courses"
    );
    try {
      return sendJson(res, 200, removeDropped(root, url.searchParams.get("name")));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === "/api/gaps/import" && req.method === "POST") {
    const body = await readBody(req);
    const root = path.resolve(body.root || readSettings().defaultRoot || [...roots][0] || "courses");
    addRoot(root);
    const mappings = (body.mappings || []).filter((m) => m && m.file && m.url);
    if (!mappings.length) return sendJson(res, 400, { error: "nothing matched yet" });
    try {
      // Filesystem-only, so it runs in-process: no browser, no singletons to
      // trip over, and the result is wanted synchronously.
      const summary = await applyImports(root, mappings, { dryRun: !!body.dryRun });
      return sendJson(res, 200, { ok: true, summary });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === "/api/dry-run" && req.method === "GET") {
    const root = path.resolve(
      url.searchParams.get("root") || readSettings().defaultRoot || [...roots][0] || "courses"
    );
    addRoot(root);
    return sendJson(res, 200, readDryRun(root));
  }

  if (pathname === "/api/plan" && req.method === "GET") {
    // Same resolution order as /api/library, so the two screens never disagree
    // about which archive is open.
    const root = path.resolve(
      url.searchParams.get("root") || readSettings().defaultRoot || [...roots][0] || "courses"
    );
    addRoot(root);
    const list = loadStudyList(root);
    return sendJson(res, 200, {
      ...list,
      summary: summarize([...list.tasks, ...list.orphans]),
    });
  }

  // Assign dates to a course's undone tasks, in course order. Existing dates
  // are treated as pins, so re-planning never silently moves work the user
  // placed by hand; `reflow` deliberately drops that protection.
  if (pathname === "/api/plan/schedule" && req.method === "POST") {
    const body = await readBody(req);
    const root = path.resolve(body.root || readSettings().defaultRoot || [...roots][0] || "courses");
    addRoot(root);
    const list = loadStudyList(root);

    const scope = list.tasks.filter(
      (t) =>
        (!body.courseId || t.courseId === body.courseId) &&
        t.state !== "removed" &&
        !t.done
    );
    const start = body.start || tomorrow();
    const pinned = new Map();
    if (!body.reflow) {
      for (const t of scope) if (t.targetDate) pinned.set(t.id, t.targetDate);
    }
    const unpinned = scope.filter((t) => !pinned.has(t.id)).length;
    const perDay = body.end
      ? ratePerDay(unpinned, start, body.end, body.skipWeekdays || [])
      : Math.max(1, Number(body.perDay) || 1);

    // Capacity is per course, deliberately.
    //
    // Seeding this with the days other courses already occupy sounds like it
    // prevents an overloaded day, but it makes courses queue one behind
    // another: with three courses at one a day each, the second would not
    // start until the first had finished, and its own end date would sail past
    // unmet. Courses run concurrently in real life. Each is paced to its own
    // deadline, and the combined daily view is where a heavy day becomes
    // visible — which is the point of having one.
    //
    // Pins still consume capacity, inside buildSchedule, because a day the
    // user filled by hand in *this* course should not receive another.
    const plan = buildSchedule(scope, {
      start,
      perDay,
      skipWeekdays: body.skipWeekdays || [],
      pinned,
    });

    updateEntries(
      root,
      plan.map((p) => {
        const task = scope.find((t) => t.id === p.id);
        return {
          itemId: p.id,
          target_date: p.date,
          snapshot: task
            ? { title: task.title, course: task.courseName, course_url: task.courseUrl, category: task.category }
            : undefined,
        };
      })
    );
    return sendJson(res, 200, { scheduled: plan.length, perDay, start });
  }

  if (pathname === "/api/plan/items" && req.method === "PATCH") {
    const body = await readBody(req);
    const root = path.resolve(body.root || readSettings().defaultRoot || [...roots][0] || "courses");
    addRoot(root);
    updateEntries(root, body.updates || []);
    return sendJson(res, 200, { ok: true, updated: (body.updates || []).length });
  }

  if (pathname === "/api/plan/clear" && req.method === "POST") {
    const body = await readBody(req);
    const root = path.resolve(body.root || readSettings().defaultRoot || [...roots][0] || "courses");
    addRoot(root);
    const list = loadStudyList(root);
    const scope = list.tasks.filter((t) => !body.courseId || t.courseId === body.courseId);
    updateEntries(root, scope.map((t) => ({ itemId: t.id, target_date: null })));
    return sendJson(res, 200, { ok: true, cleared: scope.length });
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

/**
 * Turns a request body into a job spec, mapping UI checkboxes onto the CLI's
 * own option names so runScrape receives exactly what the CLI would give it.
 */
function buildJobSpec(body, state, roots, addRoot) {
  const kind = body.kind === "login" ? "login" : body.kind === "dry-run" ? "dry-run" : "scrape";
  const url = String(body.url || "").trim();
  if (!/^https:\/\/[^/]+(\/courses\/[^/?#]+)?\/?$/.test(url)) {
    return { error: "enter a Canvas URL like https://canvas.school.edu or .../courses/123" };
  }
  const cookies = body.cookies ? path.resolve(body.cookies) : state.cookiesPath;

  if (kind === "login") {
    return { kind, url, cookies, loginMode: "fresh", cwd: path.dirname(state.configPath) };
  }

  const output = path.resolve(body.output || readSettings().defaultRoot || [...roots][0] || "courses");
  addRoot(output);
  const content = body.content || {};
  return {
    kind,
    url,
    cwd: path.dirname(state.configPath),
    options: {
      output,
      cookies,
      a: !!content.a,
      m: !!content.m,
      q: !!content.q,
      v: !!content.v,
      s: !!content.s,
      t: !!body.transcribe,
      dryRun: kind === "dry-run",
      report: !!body.report,
      wiki: !!body.wiki,
      octarine: !!body.octarine,
      fresh: !!body.fresh,
      force: !!body.force,
      prune: !!body.prune,
      loginMode: "fresh",
      courseIds: Array.isArray(body.courseIds) && body.courseIds.length ? body.courseIds : undefined,
    },
  };
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
