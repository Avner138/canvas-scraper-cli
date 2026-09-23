import puppeteer from "puppeteer";

import helpers from "../scrapers/helpers.js";
import { findChrome } from "./chrome.js";

/**
 * Launches Chrome for either a headless scrape or an interactive login.
 *
 * Prefers Puppeteer's own bundled browser, because it is the one build
 * guaranteed to speak the exact CDP dialect this version of Puppeteer was
 * compiled against. Driving a much newer system Chrome instead is what used to
 * make routine commands (Network.enable) hang until protocolTimeout and then
 * reject from inside Puppeteer's event handlers, killing the run.
 *
 * This preference was previously reversed: the bundled Chromium was pinned to
 * an old build that would not launch on newer macOS ("spawn Unknown system
 * error -88"), so the code reached for the system Chrome instead. Keeping
 * Puppeteer current removes that trade-off — the bundled browser both launches
 * and matches. The system-Chrome path stays as a fallback, because the
 * standalone pkg builds don't ship a browser.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless=true] headless mode. Pass `false` for
 *   a visible, interactive window (used by the login flow).
 * @param {string} [opts.userDataDir] persistent profile directory. Left unset
 *   today (the "fresh" login strategy uses a throwaway profile); reserved so a
 *   future persistent-profile strategy can keep the user signed in across runs.
 * @param {number} [opts.protocolTimeout] max ms to wait for any CDP command.
 *   Defaults to 300000 (5 min) — well above Puppeteer's 180s default — because
 *   opening a new tab (Target.createTarget) and rendering large course PDFs can
 *   exceed 180s under load, which otherwise aborts the scrape with a
 *   "Target.createTarget timed out" / "increase the 'protocolTimeout'" error.
 * @returns {Promise<import("puppeteer").Browser>}
 */
/**
 * A one-line gist of an error, short enough to embed in a log line.
 *
 * Puppeteer's "could not find browser" error runs to several lines of install
 * advice, and its first line ends mid-sentence. Splitting on sentence
 * punctuation doesn't help either — the version number ("ver. 154.0.8037.57")
 * has periods in it. So: first line, capped.
 * @param {Error} err
 * @returns {string}
 */
function summarizeError(err) {
  const line = ((err && err.message) || String(err || "")).trim().split("\n")[0].trim();
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

export async function launchBrowser(opts = {}) {
  const { headless = true, userDataDir, protocolTimeout = 300000 } = opts;
  const base = { headless, protocolTimeout };
  if (userDataDir) base.userDataDir = userDataDir;

  // An explicit override wins over everything. Puppeteer honors
  // PUPPETEER_EXECUTABLE_PATH itself, but CHROME_PATH is ours, and before this
  // preference was flipped findChrome() ran first so both were respected.
  // Checking only after the default launch *succeeds* would silently ignore a
  // browser the user deliberately chose.
  const override = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (override) {
    const resolved = findChrome();
    if (resolved) {
      return await puppeteer.launch({ ...base, executablePath: resolved });
    }
    helpers.print(
      "WARNING",
      "BROWSER",
      `CHROME_PATH/PUPPETEER_EXECUTABLE_PATH is set to "${override}" but no browser exists there; ignoring it.`,
      0
    );
  }

  // The protocol-matched browser Puppeteer installed for itself.
  try {
    return await puppeteer.launch(base);
  } catch (bundledErr) {
    // No bundled browser (a standalone pkg build, or the download was skipped
    // with PUPPETEER_SKIP_DOWNLOAD). Fall back to whatever Chrome is installed,
    // and say so — a version-mismatched browser is a plausible suspect if the
    // run later dies on a timed-out CDP command.
    const chromePath = findChrome();
    if (chromePath) {
      helpers.print(
        "NOTE",
        "BROWSER",
        `Puppeteer's bundled browser is unavailable (${summarizeError(bundledErr)}); falling back to the system Chrome at ${chromePath}.`,
        0
      );
      return await puppeteer.launch({ ...base, executablePath: chromePath });
    }

    helpers.print(
      "NOTE",
      "BROWSER",
      "Puppeteer's bundled browser is unavailable; trying the installed Chrome release channel.",
      0
    );
    return await puppeteer.launch({ ...base, channel: "chrome" });
  }
}

export default { launchBrowser };
