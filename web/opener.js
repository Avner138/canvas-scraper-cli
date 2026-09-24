import fs from "fs";
import path from "path";
import { spawn } from "child_process";

/**
 * Hands a local file or an http(s) URL to the operating system's default
 * handler.
 *
 * Two rules hold everywhere in here:
 *
 *  - **Never a shell.** Always `spawn(cmd, [args])`. A course item can be
 *    called anything an instructor typed, and a filename with a quote or a
 *    semicolon in it must not become a command. On Windows that rules out
 *    `cmd /c start`, whose quoting is famously unsafe; `rundll32
 *    url.dll,FileProtocolHandler` takes a plain argument and handles both
 *    files and URLs.
 *  - **Only http and https.** Handing an arbitrary scheme to the OS opener is
 *    a remote-code-execution vector, and nothing this app links to needs one.
 */

/** Schemes the OS opener may be given. */
const SAFE_SCHEMES = new Set(["http:", "https:"]);

/**
 * Resolves a path and confirms it sits inside one of the allowed roots.
 *
 * realpath first, so a symlink cannot point out of the archive and still pass
 * a string-prefix test. The separator is appended before comparing so that
 * `/tmp/archive-evil` does not read as being inside `/tmp/archive`.
 * @param {string} target
 * @param {string[]} roots absolute paths the app is allowed to open from
 * @returns {string|null} the resolved path, or null when it is outside
 */
export function resolveWithinRoots(target, roots) {
  if (!target || !Array.isArray(roots) || !roots.length) return null;
  let real;
  try {
    real = fs.realpathSync(path.resolve(target));
  } catch (e) {
    return null; // missing file, or a broken link
  }
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch (e) {
      continue;
    }
    if (real === realRoot) return real;
    if (real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) {
      return real;
    }
  }
  return null;
}

/** The platform's opener command and its leading arguments. */
function openerFor(target) {
  if (process.platform === "darwin") return ["open", [target]];
  if (process.platform === "win32") {
    return ["rundll32", ["url.dll,FileProtocolHandler", target]];
  }
  return ["xdg-open", [target]];
}

/**
 * Opens a local file that lies within one of `roots`.
 * @returns {{ok: boolean, reason?: string, path?: string}}
 */
export function openPath(target, roots) {
  const real = resolveWithinRoots(target, roots);
  if (!real) return { ok: false, reason: "outside the archive, or missing" };
  const [cmd, args] = openerFor(real);
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return { ok: true, path: real };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Opens an http(s) URL.
 * @returns {{ok: boolean, reason?: string, url?: string}}
 */
export function openUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return { ok: false, reason: "not a URL" };
  }
  if (!SAFE_SCHEMES.has(u.protocol)) {
    return { ok: false, reason: `refusing to open a ${u.protocol} link` };
  }
  const [cmd, args] = openerFor(u.href);
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return { ok: true, url: u.href };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export default { openPath, openUrl, resolveWithinRoots };
