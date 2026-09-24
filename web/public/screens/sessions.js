import { api, el, ago, until, toast } from "../lib/api.js";

/**
 * Sessions — whether the captured cookies are still good, per content source.
 *
 * The login flow already runs this check once, just before it closes the
 * browser. Expired cookies being the most common way a run fails, it is worth
 * having standing rather than as a warning you saw days ago.
 */

function sourceRow(s) {
  const status = s.ok
    ? el("span.badge.ok", {}, "valid")
    : el("span.badge.bad", {}, "missing");

  const left = until(s.expires);
  const detail = [];
  if (s.ok) {
    detail.push(`${s.count} cookie${s.count === 1 ? "" : "s"}`);
    if (left) detail.push(left);
  }

  return el(
    `div.session.${s.ok ? "ok" : "bad"}`,
    {},
    el(
      "div.who",
      {},
      el("strong", {}, s.label),
      el("span.hint", {}, s.domains.length ? s.domains.join(", ") : s.hint)
    ),
    el("div.num.muted.meta", {}, detail.join(" · ")),
    el("div", {}, status)
  );
}

export async function renderSessions() {
  const state = await api("/api/state");
  const sessions = await api(
    `/api/sessions?cookies=${encodeURIComponent(state.cookiesPath)}`
  );

  const wrap = el("div");
  wrap.append(
    el("h1", {}, "Sessions"),
    el(
      "p.sub",
      {},
      "Expired cookies are the most common way a run fails. This reads the same cookies file the scraper does, and checks it against the same host lists the login flow uses."
    )
  );

  wrap.append(
    el(
      "div.toolbar",
      {},
      el("span.muted", {}, "Cookies"),
      el("span.path", {}, sessions.path),
      el("span.spacer"),
      el(
        "button.btn.sm",
        {
          onClick: () => {
            navigator.clipboard
              ?.writeText(sessions.path)
              .then(() => toast("Path copied"))
              .catch(() => toast("Could not copy"));
          },
        },
        "Copy path"
      )
    )
  );

  if (!sessions.exists || sessions.error) {
    wrap.append(
      el("div.banner.bad", {}, sessions.error || "No cookies file found."),
      loginHelp(state)
    );
    return wrap;
  }

  wrap.append(el("div.sessions", {}, sessions.sources.map(sourceRow)));

  const missing = sessions.sources.filter((s) => !s.ok);
  const canvas = sessions.sources.find((s) => s.key === "canvas");

  if (canvas && !canvas.ok) {
    wrap.append(
      el(
        "p.note",
        {},
        el("b", {}, "Canvas has no cookies, so nothing will scrape. "),
        "Capture a session before running anything."
      )
    );
  } else if (missing.length) {
    wrap.append(
      el(
        "p.note",
        {},
        el("b", {}, `${missing.map((m) => m.label).join(" and ")} not captured. `),
        "Those downloads will be skipped and reported rather than failing the run. ",
        "To include them, sign in to each site in the same browser window during login."
      )
    );
  }

  wrap.append(loginHelp(state));

  wrap.append(
    el(
      "p.note",
      {},
      `Read ${ago(new Date().toISOString())} from a file of ${sessions.count} cookie(s). `,
      "Session cookies carry no expiry date — an empty expiry doesn't mean they're bad, only that they die with the browser that made them."
    )
  );

  return wrap;
}

/**
 * Login is still a terminal flow in this milestone: it opens a real browser
 * window and waits on stdin. Driving it from here needs the job runner, so
 * rather than pretend, show the exact command.
 */
function loginHelp(state) {
  const cmd = `node index.js login https://<your-canvas-domain>`;
  return el(
    "div.section",
    {},
    el("h2", {}, "Capturing a session"),
    el(
      "p.sub",
      {},
      "Login opens a real Chrome window and waits for you to sign in, so for now it runs in a terminal. Driving it from this app arrives with the job runner."
    ),
    el(
      "div.toolbar",
      {},
      el("code.path", {}, cmd),
      el(
        "button.btn.sm",
        {
          onClick: () => {
            navigator.clipboard
              ?.writeText(cmd)
              .then(() => toast("Command copied"))
              .catch(() => toast("Could not copy"));
          },
        },
        "Copy"
      )
    ),
    state.chrome?.found
      ? null
      : el("div.banner.warn", {}, "Google Chrome was not found — login needs it.")
  );
}
