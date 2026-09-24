import { api, el, ago, until, toast } from "../lib/api.js";
import { watchJob, replyPrompt } from "../lib/stream.js";

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
      loginPanel(state, sessions)
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

  wrap.append(loginPanel(state, sessions));

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
 * Capturing a session, driven from here.
 *
 * Login is interactive by nature: a real Chrome window opens and the user
 * signs in themselves, which is what makes SSO and two-factor work at all. The
 * flow asks to be told when that is done, and asks a second time after
 * checking for Panopto and Study.Net — so the prompt mechanism is
 * id-addressed rather than a single hard-coded "press Enter".
 *
 * Two windows are inherently confusing, so this screen says plainly which one
 * wants attention, and shows the login's own log while it waits.
 */
function loginPanel(state, sessions) {
  const box = el("div.panel.section", {});

  // Pre-filled from the cookies already captured, since the domain is almost
  // always the same one as last time.
  const known = sessions.sources?.find((x) => x.key === "canvas")?.domains?.[0];
  const domain = el("input.pathbox", {
    type: "text",
    value: known ? `https://${known}` : "",
    placeholder: "https://canvas.your-school.edu",
    "aria-label": "Canvas URL",
  });

  const status = el("div.loginstatus", {});
  const logBox = el("pre.joblog", { hidden: true });
  const actions = el("div.toolbar", {});

  let close = null;
  const appendLog = (r) => {
    logBox.hidden = false;
    logBox.append(
      el(`span.l-${String(r.type || "info").toLowerCase()}`, {}, `${r.message}\n`)
    );
    logBox.scrollTop = logBox.scrollHeight;
  };

  const startBtn = el(
    "button.btn.primary",
    {
      onClick: async () => {
        const url = domain.value.trim();
        if (!url) return toast("Enter your Canvas URL first");
        try {
          const { id } = await api("/api/jobs", {
            method: "POST",
            body: JSON.stringify({ kind: "login", url, cookies: state.cookiesPath }),
          });
          startBtn.disabled = true;
          domain.disabled = true;
          logBox.replaceChildren();
          waiting(id);
          close = watchJob(id, {
            onLog: appendLog,
            onPrompt: ({ promptId, message }) => {
              if (promptId) askUser(id, promptId, message);
              else waiting(id);
            },
            onEnd: (job) => finished(job),
          });
        } catch (e) {
          toast(e.message);
        }
      },
    },
    "Capture session"
  );

  const cancelBtn = el(
    "button.btn.danger.sm",
    {
      hidden: true,
      onClick: async () => {
        await api(`/api/jobs/${cancelBtn.dataset.job}/cancel`, { method: "POST" }).catch(() => {});
      },
    },
    "Cancel login"
  );

  /** Chrome is open and the user has not said they are done yet. */
  const waiting = (jobId) => {
    cancelBtn.hidden = false;
    cancelBtn.dataset.job = jobId;
    status.replaceChildren(
      el("span.badge.warn", {}, "waiting for you"),
      el(
        "span.meta",
        {},
        " A Chrome window has opened. Sign in to Canvas there — and to Panopto and Study.Net in the same window if you want videos and course-pack materials."
      )
    );
    actions.replaceChildren(cancelBtn);
  };

  /** The flow is blocked on a question; answering it is one click. */
  const askUser = (jobId, promptId, message) => {
    cancelBtn.hidden = false;
    cancelBtn.dataset.job = jobId;
    status.replaceChildren(
      el("span.badge.bad", {}, "needs you"),
      el("span.meta", {}, ` ${(message || "").replace(/\s*press enter.*$/i, "").trim()}`)
    );
    actions.replaceChildren(
      el(
        "button.btn.primary",
        {
          onClick: async () => {
            await replyPrompt(jobId, promptId).catch((e) => toast(e.message));
            waiting(jobId);
          },
        },
        "I've signed in — continue"
      ),
      cancelBtn
    );
  };

  const finished = (job) => {
    if (close) close();
    cancelBtn.hidden = true;
    actions.replaceChildren();
    if (job.status === "done") {
      status.replaceChildren(el("span.badge.ok", {}, "captured"));
      toast("Session captured");
      // Re-read the badges above rather than guessing what was captured.
      setTimeout(() => window.__refresh(), 700);
      return;
    }
    status.replaceChildren(
      el("span.badge.bad", {}, job.status),
      el("span.meta", {}, ` ${job.error || "the login did not finish"}`)
    );
    startBtn.disabled = false;
    domain.disabled = false;
  };

  box.append(
    el("h3", {}, "Capture a session"),
    el(
      "p.sub",
      {},
      "Opens a real Chrome window so you can sign in yourself — single sign-on and two-factor included. Nothing is typed for you, and no password passes through this app."
    ),
    el("div.toolbar", {}, domain, startBtn),
    status,
    actions,
    logBox
  );
  return box;
}
