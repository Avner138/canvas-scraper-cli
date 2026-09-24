import fs from "fs";

import { readCookies, readJSON } from "../core/scrape.js";
import {
  videoAuthHosts,
  studyNetAuthHosts,
  hasCookiesForHosts,
} from "../core/login.js";

/**
 * Reports whether the captured cookies are still good for each content source.
 *
 * Expired cookies are the most common way a run fails, and the login flow
 * already knows how to check for them — it warns before closing the browser
 * (core/login.js). All this does is make that check standing rather than a
 * warning you see once, using the same host lists so the two can never
 * disagree.
 */

/** Cookies whose domain matches one of `hosts`, with their expiry. */
function matching(cookies, hosts) {
  const out = [];
  for (const c of cookies) {
    const domain = String(c.domain || "").replace(/^\./, "").toLowerCase();
    if (!domain) continue;
    for (const h of hosts) {
      const host = String(h).toLowerCase();
      if (domain === host || domain.endsWith(`.${host}`)) {
        out.push(c);
        break;
      }
    }
  }
  return out;
}

/**
 * The soonest real expiry among a set of cookies, as an ISO string.
 *
 * Session cookies carry -1 (or 0 from a Netscape file) and are skipped: they
 * expire when the browser closes, which is not a date we can show. A set of
 * only session cookies therefore reports no expiry rather than a fake one.
 */
function earliestExpiry(cookies) {
  const stamps = cookies
    .map((c) => Number(c.expires))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!stamps.length) return null;
  return new Date(Math.min(...stamps) * 1000).toISOString();
}

/** The distinct domains present, for showing what was actually captured. */
function domainsOf(cookies) {
  return [...new Set(cookies.map((c) => String(c.domain || "").replace(/^\./, "")))]
    .filter(Boolean)
    .sort();
}

/**
 * Reads a cookies file and reports per-source status.
 * @param {string} cookiesPath
 * @param {string} [configPath] config.json, for the configured video hosts
 */
export function readSessions(cookiesPath, configPath = "config.json") {
  const out = {
    path: cookiesPath,
    exists: fs.existsSync(cookiesPath),
    count: 0,
    error: null,
    sources: [],
  };
  if (!out.exists) {
    out.error = "no cookies file — run a login";
    return out;
  }

  let cookies;
  try {
    cookies = readCookies(cookiesPath);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  out.count = cookies.length;

  let config = {};
  try {
    config = readJSON(configPath, "config");
  } catch (e) {
    // Without config.json we lose only the user's extra videoHosts; the
    // built-in Panopto defaults still apply.
  }

  const canvas = cookies.filter((c) => /canvas|instructure/i.test(String(c.domain || "")));
  const videoHosts = videoAuthHosts(config);
  const studyHosts = studyNetAuthHosts();
  const video = matching(cookies, videoHosts);
  const study = matching(cookies, studyHosts);

  out.sources = [
    {
      key: "canvas",
      label: "Canvas",
      ok: canvas.length > 0,
      count: canvas.length,
      domains: domainsOf(canvas),
      expires: earliestExpiry(canvas),
      hint: "Required. Without it nothing scrapes.",
    },
    {
      key: "panopto",
      label: "Panopto",
      ok: hasCookiesForHosts(cookies, videoHosts),
      count: video.length,
      domains: domainsOf(video),
      expires: earliestExpiry(video),
      hint: "Needed for lecture video downloads (-v).",
    },
    {
      key: "studynet",
      label: "Study.Net",
      ok: hasCookiesForHosts(cookies, studyHosts),
      count: study.length,
      domains: domainsOf(study),
      expires: earliestExpiry(study),
      hint: "Needed for course-pack materials (-s).",
    },
  ];
  return out;
}

export default { readSessions };
