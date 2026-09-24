/* Canvas Archivist — browser app.
   Plain ES modules and DOM. The server's CSP is default-src 'self', so there
   is no CDN and no framework; an el() helper is enough for these screens. */

import { renderLibrary } from "./screens/library.js";
import { renderSessions } from "./screens/sessions.js";
import { setToken, api, toast } from "./lib/api.js";

/**
 * The token arrives in the query string because that is the only way the
 * server can hand it to a freshly opened tab. Move it into sessionStorage and
 * strip it from the URL immediately: a page URL carrying a credential ends up
 * in history, and in a Referer header on any outbound link.
 */
function claimToken() {
  const url = new URL(location.href);
  const fromQuery = url.searchParams.get("t");
  if (fromQuery) {
    try {
      sessionStorage.setItem("cs-token", fromQuery);
    } catch (e) {
      /* private window: the in-memory token below still works for this page */
    }
    url.searchParams.delete("t");
    history.replaceState({}, "", url.pathname + url.hash);
    return fromQuery;
  }
  try {
    return sessionStorage.getItem("cs-token") || "";
  } catch (e) {
    return "";
  }
}

const SCREENS = {
  library: renderLibrary,
  sessions: renderSessions,
};

const main = document.getElementById("main");
let current = "";

async function show(name, { focus = false } = {}) {
  const render = SCREENS[name] || SCREENS.library;
  current = SCREENS[name] ? name : "library";
  for (const btn of document.querySelectorAll(".navbtn")) {
    btn.setAttribute("aria-current", btn.dataset.screen === current ? "true" : "false");
  }
  if (location.hash.replace("#", "") !== current) {
    history.replaceState({}, "", `#${current}`);
  }
  main.replaceChildren();
  main.append(Object.assign(document.createElement("p"), {
    className: "muted",
    textContent: "Loading…",
  }));
  try {
    const node = await render();
    main.replaceChildren(node);
  } catch (e) {
    main.replaceChildren(errorCard(e));
  }
  if (focus) main.focus();
}

/** A failed screen should say what failed, not go blank. */
function errorCard(e) {
  const div = document.createElement("div");
  div.className = "banner bad";
  div.textContent = `Could not load this screen: ${e.message || e}`;
  return div;
}

function wire() {
  for (const btn of document.querySelectorAll(".navbtn")) {
    btn.addEventListener("click", () => show(btn.dataset.screen, { focus: true }));
  }
  document.getElementById("quit").addEventListener("click", async () => {
    try {
      await api("/api/shutdown", { method: "POST" });
    } catch (e) {
      /* the server going away mid-request is the expected outcome */
    }
    document.body.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "muted pad",
        textContent: "Server stopped. You can close this tab.",
      })
    );
  });
  addEventListener("hashchange", () => {
    const name = location.hash.replace("#", "");
    if (name && name !== current) show(name);
  });
  // A screen re-reads from disk, so coming back to the tab should refresh it.
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") show(current);
  });
}

setToken(claimToken());
wire();
show(location.hash.replace("#", "") || "library");

// Exposed so screens can trigger a refresh after an action.
window.__refresh = () => show(current);
window.__toast = toast;
