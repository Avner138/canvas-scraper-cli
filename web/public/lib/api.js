/* Shared helpers: the authenticated fetch, a tiny DOM builder, formatters. */

let TOKEN = "";

export function setToken(t) {
  TOKEN = t || "";
}

/**
 * Calls the local API.
 *
 * The token travels in a custom header rather than a cookie: a cross-origin
 * form or image cannot set one, so this is CSRF defence as well as auth.
 */
export async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      "X-CS-Token": TOKEN,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    /* some responses have no body */
  }
  if (!res.ok) {
    // A stale token is the one failure a user hits by accident — reloading a
    // bookmarked page, or coming back after the server restarted, since each
    // launch mints a new one. "bad token" tells them nothing, so say what to
    // do about it.
    if (res.status === 401) {
      const err = new Error(
        "This page's access token is no longer valid — the server has restarted since it was opened. " +
          "Open the link the terminal printed again."
      );
      err.code = "stale-token";
      throw err;
    }
    const msg = (body && (body.error || body.reason)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/** Element builder: el("div.card", {title: "x"}, child, "text"). */
export function el(spec, props = {}, ...children) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = [node.className, v].filter(Boolean).join(" ");
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in node && k !== "style") node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** A short-lived status message. */
export function toast(message) {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

/** Bytes as a short human string. */
export function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** A relative time like "2h ago" — absolute once it is older than a week. */
export function ago(iso) {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const secs = (Date.now() - then.getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return then.toLocaleDateString();
}

/** How long until an expiry — the number that decides "re-login or not". */
export function until(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const secs = (then.getTime() - Date.now()) / 1000;
  if (secs <= 0) return "expired";
  if (secs < 3600) return `${Math.floor(secs / 60)}m left`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h left`;
  return `${Math.floor(secs / 86400)}d left`;
}

/** Asks the server to open a local file, reporting why if it refuses. */
export async function openPath(p) {
  try {
    await api("/api/open", { method: "POST", body: JSON.stringify({ path: p }) });
  } catch (e) {
    toast(`Could not open: ${e.message}`);
  }
}

/** Asks the server to open an http(s) URL. */
export async function openUrl(u) {
  try {
    await api("/api/open", { method: "POST", body: JSON.stringify({ url: u }) });
  } catch (e) {
    toast(`Could not open: ${e.message}`);
  }
}
