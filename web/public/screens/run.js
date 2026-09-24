import { api, el, bytes, toast } from "../lib/api.js";
import { openPicker } from "../lib/picker.js";
import { watchJob } from "../lib/stream.js";

/**
 * Run — set a scrape up, start it, and watch it.
 *
 * The form maps onto the CLI's own flags rather than inventing new vocabulary,
 * so what happens here is the same thing `canvas-scraper -a -m …` does, and a
 * problem is debuggable from either side.
 */

const CONTENT = [
  ["a", "Assignments", "-a"],
  ["m", "Modules", "-m"],
  ["q", "Quizzes", "-q"],
  ["v", "Videos (Panopto)", "-v"],
  ["s", "Study.Net materials", "-s"],
];

const EXTRAS = [
  ["report", "Write CSV reports", "--report"],
  ["wiki", "LLM Wiki layout", "--wiki"],
  ["octarine", "Octarine workspace", "--octarine"],
  ["transcribe", "Transcribe videos", "-t"],
];

/** Remembered across renders so a navigation away doesn't reset the form. */
let FORM = null;

function defaults(state) {
  return {
    url: "",
    output: state.settings?.defaultRoot || state.roots?.[0] || "courses",
    content: { a: true, m: true, q: false, v: false, s: false },
    mode: "resume", // resume | fresh | force
    prune: false,
    report: true,
    wiki: false,
    octarine: false,
    transcribe: false,
  };
}

export async function renderRun() {
  const state = await api("/api/state");
  const sessions = await api(
    `/api/sessions?cookies=${encodeURIComponent(state.cookiesPath)}`
  );
  const { jobs, active } = await api("/api/jobs");
  if (!FORM) FORM = defaults(state);

  const wrap = el("div");
  wrap.append(
    el("h1", {}, "Run"),
    el(
      "p.sub",
      {},
      "Start a scrape and watch it. One at a time — the scraper keeps per-run state that two simultaneous runs would corrupt."
    )
  );

  const running = jobs.find((j) => j.id === active && j.status === "running");
  if (running) {
    wrap.append(liveJob(running));
    return wrap;
  }

  if (!state.chrome?.found) {
    wrap.append(
      el("div.banner.bad", {}, "Google Chrome was not found — a scrape cannot run without it.")
    );
  }
  const canvas = sessions.sources?.find((s) => s.key === "canvas");
  if (!canvas?.ok) {
    wrap.append(
      el(
        "div.banner.bad",
        {},
        "No Canvas cookies, so nothing will scrape. Capture a session from the Sessions screen first."
      )
    );
  }
  const missing = (sessions.sources || []).filter((s) => !s.ok && s.key !== "canvas");
  if (canvas?.ok && missing.length) {
    wrap.append(
      el(
        "div.banner.warn",
        {},
        `${missing.map((m) => m.label).join(" and ")} not captured — those downloads will be skipped and reported rather than failing the run.`
      )
    );
  }

  wrap.append(form(state));
  if (jobs.length) wrap.append(history(jobs));
  return wrap;
}

function form(state) {
  const box = el("div.panel", {});
  const urlInput = el("input.pathbox", {
    type: "text",
    value: FORM.url,
    placeholder: "https://canvas.school.edu/courses/12345  — or just the domain for every course",
    "aria-label": "Canvas URL",
    onInput: (e) => {
      FORM.url = e.target.value;
    },
  });

  const outLabel = el("span.path", {}, FORM.output);
  const contentBox = el("div.checkgrid", {});
  for (const [key, label, flag] of CONTENT) {
    contentBox.append(
      el(
        "label.check",
        {},
        el("input", {
          type: "checkbox",
          checked: FORM.content[key],
          onChange: (e) => {
            FORM.content[key] = e.target.checked;
          },
        }),
        el("span", {}, label, el("span.meta.muted.sub-line", {}, flag))
      )
    );
  }

  const modeBox = el("div.checkgrid", {});
  for (const [value, label, hint] of [
    ["resume", "Resume", "keep what's on disk (default)"],
    ["fresh", "Fresh", "--fresh · wipes each course folder"],
    ["force", "Force", "--force · ignore the manifest"],
  ]) {
    modeBox.append(
      el(
        "label.check",
        {},
        el("input", {
          type: "radio",
          name: "mode",
          checked: FORM.mode === value,
          onChange: () => {
            FORM.mode = value;
          },
        }),
        el("span", {}, label, el("span.meta.muted.sub-line", {}, hint))
      )
    );
  }

  const extraBox = el("div.checkgrid", {});
  for (const [key, label, flag] of EXTRAS) {
    extraBox.append(
      el(
        "label.check",
        {},
        el("input", {
          type: "checkbox",
          checked: FORM[key],
          onChange: (e) => {
            FORM[key] = e.target.checked;
          },
        }),
        el("span", {}, label, el("span.meta.muted.sub-line", {}, flag))
      )
    );
  }
  extraBox.append(
    el(
      "label.check",
      {},
      el("input", {
        type: "checkbox",
        checked: FORM.prune,
        onChange: (e) => {
          FORM.prune = e.target.checked;
        },
      }),
      el(
        "span",
        {},
        "Delete vanished files",
        el("span.meta.muted.sub-line", {}, "--prune · removes local copies whose source is gone")
      )
    )
  );

  const start = async (kind) => {
    try {
      const body = {
        kind,
        url: FORM.url.trim(),
        output: FORM.output,
        content: FORM.content,
        fresh: FORM.mode === "fresh",
        force: FORM.mode === "force",
        prune: FORM.prune,
        report: FORM.report,
        wiki: FORM.wiki,
        octarine: FORM.octarine,
        transcribe: FORM.transcribe,
      };
      await api("/api/jobs", { method: "POST", body: JSON.stringify(body) });
      window.__refresh();
    } catch (e) {
      toast(e.message);
    }
  };

  box.append(
    el("h3", {}, "New run"),
    el("div.field", {}, el("label.muted.meta", {}, "Canvas URL"), urlInput),
    el(
      "div.field",
      {},
      el("label.muted.meta", {}, "Download into"),
      el(
        "div.toolbar",
        {},
        outLabel,
        el(
          "button.btn.sm",
          {
            onClick: () =>
              openPicker({
                current: FORM.output,
                onChoose: (p) => {
                  FORM.output = p;
                  outLabel.textContent = p;
                },
              }),
          },
          "Change…"
        )
      )
    ),
    el("div.field", {}, el("label.muted.meta", {}, "Content"), contentBox),
    el("div.field", {}, el("label.muted.meta", {}, "Mode"), modeBox),
    el("div.field", {}, el("label.muted.meta", {}, "Extras"), extraBox),
    el(
      "div.toolbar",
      {},
      el(
        "button.btn",
        { onClick: () => start("dry-run") },
        "Dry run"
      ),
      el("button.btn.primary", { onClick: () => start("scrape") }, "Start scrape"),
      el("span.spacer"),
      el(
        "span.muted.meta",
        {},
        "A dry run probes every item for reachability and downloads nothing."
      )
    )
  );
  return box;
}

/** The live view: progress, the current download, and a filtered log. */
function liveJob(job) {
  const box = el("div.panel.live", {});
  const phase = el("span.badge.idle", {}, job.progress?.phase || "starting");
  const course = el("span.coursename", {}, job.progress?.course || job.url);
  const counter = el("span.num.muted.meta", {}, "");
  const dl = el("div.dlrow", {});
  const bar = el("progress", { value: 0, max: 100 });
  const logBox = el("pre.joblog", {});

  const paint = (p) => {
    if (!p) return;
    if (p.phase !== undefined) phase.textContent = p.phase || "working";
    if (p.course) course.textContent = p.course;
    if (p.courses) counter.textContent = `course ${p.courseIndex || 1} of ${p.courses}`;
    dl.replaceChildren();
    const d = p.download;
    if (d) {
      dl.append(
        el("span.meta", {}, d.name || d.scope),
        el(
          "span.num.muted.meta",
          {},
          d.total ? `${bytes(d.received)} / ${bytes(d.total)}` : bytes(d.received)
        )
      );
      bar.value = Math.round(d.percent || 0);
      bar.max = 100;
    } else {
      bar.value = 0;
    }
  };
  paint(job.progress);

  const appendLog = (r) => {
    const line = el(
      `span.l-${String(r.type || "info").toLowerCase()}`,
      {},
      `${r.name ? `[${r.name}] ` : ""}${r.message}\n`
    );
    logBox.append(line);
    logBox.scrollTop = logBox.scrollHeight;
  };

  api(`/api/jobs/${job.id}/log`).then(({ records }) => records.forEach(appendLog)).catch(() => {});

  // One shared stream helper, so Run and Sessions agree about the event shape
  // and both handle a job that ended before the subscription was made.
  const close = watchJob(job.id, {
    onLog: appendLog,
    onProgress: paint,
    onEnd: (finished) => {
      toast(`Run ${finished.status}`);
      window.__refresh();
    },
  });
  box._cleanup = close;

  box.append(
    el(
      "div.toolbar",
      {},
      el("span.badge.ok", {}, job.kind === "dry-run" ? "dry run" : "scraping"),
      course,
      phase,
      counter,
      el("span.spacer"),
      el(
        "button.btn.danger.sm",
        {
          onClick: async () => {
            await api(`/api/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {});
            toast("Stopping — partial results are kept");
          },
        },
        "Stop"
      )
    ),
    bar,
    dl,
    logBox,
    el(
      "p.note",
      {},
      "Stopping is graceful: the run flushes every report before it exits, so whatever it already downloaded stays on disk and a later run resumes from it."
    )
  );
  return box;
}

/** Recent runs, so a finished job is still inspectable. */
function history(jobs) {
  const rows = jobs.slice(0, 8).map((j) =>
    el(
      `tr.sev-${j.status === "done" ? "ok" : j.status === "cancelled" ? "warn" : j.status === "failed" ? "bad" : "ghost"}`,
      {},
      el("td.stripe", {}, el("span.badge." + badgeFor(j.status), {}, j.status)),
      el("td", {}, j.kind),
      el("td.path", {}, j.url),
      el("td.num", {}, new Date(j.started).toLocaleTimeString()),
      el("td.num", {}, String(j.logLines)),
      el("td", {}, j.error ? el("span.is-bad.meta", {}, j.error) : "")
    )
  );
  return el(
    "div",
    { class: "section" },
    el("h2", {}, "Recent runs"),
    el(
      "div.tablewrap",
      {},
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, "Status"),
            el("th", {}, "Kind"),
            el("th", {}, "Target"),
            el("th", {}, "Started"),
            el("th", {}, "Log"),
            el("th", {}, "")
          )
        ),
        el("tbody", {}, rows)
      )
    )
  );
}

function badgeFor(status) {
  if (status === "done") return "ok";
  if (status === "failed") return "bad";
  if (status === "cancelled") return "warn";
  return "idle";
}
