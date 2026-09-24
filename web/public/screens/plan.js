import { api, el, ago, openPath, openUrl, toast } from "../lib/api.js";
import { today, addDays, daysBetween, ratePerDay, tomorrow } from "../lib/schedule.js";

/**
 * Plan — the archive as work to get through.
 *
 * The landing view is the next seven days, combined across every course and
 * tagged by course, because you have one day rather than one per course. A
 * 221-item course is unreadable as a list, so the full tree lives behind a
 * tab with sections collapsed.
 */

let VIEW = "week"; // week | all | course
let FILTER = { course: "", status: "todo" };

/** Friendly day label: Today, Tomorrow, Overdue, else a weekday and date. */
function dayLabel(date, now) {
  if (date < now) return "Overdue";
  if (date === now) return "Today";
  if (date === addDays(now, 1)) return "Tomorrow";
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** One task row. */
function taskRow(task, root, refresh) {
  const check = el("input", {
    type: "checkbox",
    checked: task.done,
    "aria-label": `Mark ${task.title} done`,
    onChange: async (e) => {
      const done = e.target.checked;
      try {
        await api("/api/plan/items", {
          method: "PATCH",
          body: JSON.stringify({
            root,
            updates: [
              {
                itemId: task.id,
                done,
                snapshot: {
                  title: task.title,
                  course: task.courseName,
                  course_url: task.courseUrl,
                  category: task.category,
                },
              },
            ],
          }),
        });
        row.classList.toggle("done", done);
      } catch (err) {
        e.target.checked = !done;
        toast(`Could not save: ${err.message}`);
      }
    },
  });

  const title = el("button.linklike", {
    title: task.exists ? task.localPath : "No local file for this item",
    disabled: !task.exists,
    onClick: () => openPath(task.localPath),
  }, task.title);

  const meta = el("span.taskmeta", {});
  meta.append(el("span.chip", {}, task.courseName || "—"));
  if (task.section) meta.append(el("span.muted", {}, task.section));
  if (task.dueAt) {
    meta.append(el("span.chip.due", {}, `due ${task.dueAt.slice(0, 10)}`));
  }
  if (task.state === "removed") {
    meta.append(el("span.chip.ghost", {}, "no longer in course"));
  }
  if (task.orphan) meta.append(el("span.chip.ghost", {}, "orphaned"));
  if (!task.exists && !task.orphan) {
    meta.append(el("span.chip.warn", {}, "file missing"));
  }

  const actions = el("span.taskactions", {});
  if (task.canvasUrl) {
    actions.append(
      el("button.btn.sm", { onClick: () => openUrl(task.canvasUrl) }, "Canvas ↗")
    );
  }
  const dateInput = el("input.dateinput", {
    type: "date",
    value: task.targetDate || "",
    "aria-label": `Target date for ${task.title}`,
    onChange: async (e) => {
      try {
        await api("/api/plan/items", {
          method: "PATCH",
          body: JSON.stringify({
            root,
            updates: [{ itemId: task.id, target_date: e.target.value || null }],
          }),
        });
        toast("Date saved");
        refresh();
      } catch (err) {
        toast(`Could not save: ${err.message}`);
      }
    },
  });
  actions.append(dateInput);

  const row = el(
    `div.task${task.done ? ".done" : ""}`,
    {},
    check,
    el("div.taskbody", {}, title, meta),
    actions
  );
  return row;
}

/**
 * A progress bar. Native <progress> rather than a styled div: it needs no
 * inline width (which the CSP's style-src would block), and it is announced
 * correctly by a screen reader for free.
 */
function progress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return el(
    "div.progress",
    {},
    el("progress", { value: done, max: Math.max(1, total) }),
    el("span.num.muted.meta", {}, `${done} of ${total} done · ${pct}%`)
  );
}

export async function renderPlan() {
  const state = await api("/api/state");
  const root = state.settings?.defaultRoot || state.roots?.[0] || "courses";
  const data = await api(`/api/plan?root=${encodeURIComponent(root)}`);
  const refresh = () => window.__refresh();
  const now = today();

  const wrap = el("div");
  wrap.append(
    el("h1", {}, "Plan"),
    el(
      "p.sub",
      {},
      "Every downloaded reading, video, assignment and quiz as something to work through. Clicking a task opens the file itself."
    )
  );

  const all = [...data.tasks, ...data.orphans];
  if (!all.length) {
    wrap.append(
      el(
        "div.banner.warn",
        {},
        data.courses.length
          ? "These courses were scraped before the catalog existed, so there is nothing to plan yet. Re-scrape one — anything already downloaded is skipped."
          : "No scraped courses found in this archive yet."
      )
    );
    return wrap;
  }

  const s = data.summary;
  const strip = el(
    "dl.strip",
    {},
    el("div", {}, el("dt", {}, "Tasks"), el("dd", {}, String(s.total))),
    el("div", {}, el("dt", {}, "Done"), el("dd", {}, String(s.done))),
    el(
      "div",
      {},
      el("dt", {}, "Due today"),
      el("dd", { class: s.dueToday ? "is-warn" : "" }, String(s.dueToday))
    ),
    el(
      "div",
      {},
      el("dt", {}, "Overdue"),
      el("dd", { class: s.overdue ? "is-bad" : "" }, String(s.overdue))
    ),
    el(
      "div",
      {},
      el("dt", {}, "Unscheduled"),
      el("dd", { class: s.unscheduled ? "is-warn" : "" }, String(s.unscheduled))
    ),
    el("div", {}, el("dt", {}, "Finish by"), el("dd", {}, s.finishBy || "—"))
  );
  wrap.append(strip);

  wrap.append(progress(s.done, s.total));

  wrap.append(planner(data, root, refresh, now));

  // Tabs
  const tabs = el("div.toolbar", {});
  for (const [key, label] of [["week", "This week"], ["all", "All tasks"]]) {
    tabs.append(
      el(
        `button.btn.sm${VIEW === key ? ".primary" : ""}`,
        {
          onClick: () => {
            VIEW = key;
            refresh();
          },
        },
        label
      )
    );
  }
  const courseSel = el("select.sel", {
    onChange: (e) => {
      FILTER.course = e.target.value;
      refresh();
    },
  });
  courseSel.append(el("option", { value: "" }, "All courses"));
  for (const c of data.courses.filter((c) => c.indexed)) {
    courseSel.append(
      el("option", { value: c.id, selected: FILTER.course === c.id }, c.name)
    );
  }
  const statusSel = el("select.sel", {
    onChange: (e) => {
      FILTER.status = e.target.value;
      refresh();
    },
  });
  for (const [v, l] of [["todo", "To do"], ["all", "Everything"], ["done", "Done"]]) {
    statusSel.append(el("option", { value: v, selected: FILTER.status === v }, l));
  }
  tabs.append(el("span.spacer"), courseSel, statusSel);
  wrap.append(tabs);

  let shown = all.filter((t) => !FILTER.course || t.courseId === FILTER.course);
  if (FILTER.status === "todo") shown = shown.filter((t) => !t.done);
  if (FILTER.status === "done") shown = shown.filter((t) => t.done);

  wrap.append(VIEW === "week" ? weekView(shown, root, refresh, now) : allView(shown, root, refresh));
  return wrap;
}

/** The scheduling controls: an end date, or a flat rate. */
function planner(data, root, refresh, now) {
  const courses = data.courses.filter((c) => c.indexed);
  const box = el("div.panel.planner", {});
  box.append(el("h3", {}, "Schedule"));

  const courseSel = el("select.sel", {});
  courseSel.append(el("option", { value: "" }, "All courses"));
  for (const c of courses) courseSel.append(el("option", { value: c.id }, c.name));

  const endInput = el("input.dateinput", {
    type: "date",
    value: addDays(now, 30),
    "aria-label": "Finish by",
  });
  const skip = el("input", { type: "checkbox", id: "skipwk" });
  const preview = el("span.muted.meta", {});

  const update = () => {
    const id = courseSel.value;
    const remaining = data.tasks.filter(
      (t) => (!id || t.courseId === id) && !t.done && t.state !== "removed"
    ).length;
    const start = tomorrow();
    const end = endInput.value;
    if (!remaining) return (preview.textContent = "nothing left to schedule");
    if (!end || daysBetween(start, end) < 0) {
      return (preview.textContent = `${remaining} task(s) · pick an end date`);
    }
    const rate = ratePerDay(remaining, start, end, skip.checked ? [0, 6] : []);
    preview.textContent = `${remaining} task(s) · ${rate}/day · ${start} → ${end}`;
  };
  courseSel.addEventListener("change", update);
  endInput.addEventListener("change", update);
  skip.addEventListener("change", update);

  const go = el(
    "button.btn.primary.sm",
    {
      onClick: async () => {
        try {
          const r = await api("/api/plan/schedule", {
            method: "POST",
            body: JSON.stringify({
              root,
              courseId: courseSel.value || undefined,
              start: tomorrow(),
              end: endInput.value,
              skipWeekdays: skip.checked ? [0, 6] : [],
            }),
          });
          toast(`Scheduled ${r.scheduled} task(s) at ${r.perDay}/day`);
          refresh();
        } catch (e) {
          toast(`Could not schedule: ${e.message}`);
        }
      },
    },
    "Schedule"
  );

  box.append(
    el(
      "div.toolbar",
      {},
      courseSel,
      el("label.muted.meta", {}, "finish by"),
      endInput,
      el("label.muted.meta", {}, skip, " skip weekends"),
      go,
      el(
        "button.btn.sm",
        {
          onClick: async () => {
            await api("/api/plan/clear", {
              method: "POST",
              body: JSON.stringify({ root, courseId: courseSel.value || undefined }),
            });
            toast("Dates cleared");
            refresh();
          },
        },
        "Clear dates"
      )
    ),
    preview,
    el(
      "p.note",
      {},
      "Dates you set by hand are kept and count against their day, so scheduling never moves work you placed yourself. Missing a day doesn't reshuffle anything — it just shows as overdue."
    )
  );
  update();
  return box;
}

/** Overdue, then the next seven days. */
function weekView(tasks, root, refresh, now) {
  const wrap = el("div.days", {});
  const byDay = new Map();
  const undated = [];
  for (const t of tasks) {
    if (!t.targetDate) {
      undated.push(t);
      continue;
    }
    const key = t.targetDate < now ? "overdue" : t.targetDate;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }

  const keys = ["overdue", ...Array.from({ length: 7 }, (_, i) => addDays(now, i))];
  let any = false;
  for (const key of keys) {
    const list = byDay.get(key);
    if (!list || !list.length) continue;
    any = true;
    const date = key === "overdue" ? null : key;
    wrap.append(
      el(
        "div.day",
        {},
        el(
          "div.dayhead",
          {},
          el(
            `span.daylabel${key === "overdue" ? ".is-bad" : date === now ? ".is-now" : ""}`,
            {},
            key === "overdue" ? "Overdue" : dayLabel(date, now)
          ),
          el("span.num.muted.meta", {}, `${list.length} item${list.length === 1 ? "" : "s"}`)
        ),
        el("div.tasklist", {}, list.map((t) => taskRow(t, root, refresh)))
      )
    );
  }

  if (!any) {
    wrap.append(
      el(
        "div.banner.warn",
        {},
        undated.length
          ? `Nothing scheduled in the next seven days — ${undated.length} task(s) have no date yet. Use Schedule above.`
          : "Nothing due in the next seven days."
      )
    );
  }
  if (undated.length) {
    wrap.append(
      el(
        "p.note",
        {},
        `${undated.length} task(s) have no target date. They're in All tasks.`
      )
    );
  }
  return wrap;
}

/** Everything, grouped by course then section, sections collapsed. */
function allView(tasks, root, refresh) {
  const wrap = el("div.days", {});
  const byCourse = new Map();
  for (const t of tasks) {
    const k = t.courseName || "—";
    if (!byCourse.has(k)) byCourse.set(k, []);
    byCourse.get(k).push(t);
  }

  for (const [course, list] of byCourse) {
    const bySection = new Map();
    for (const t of list) {
      const k = `${t.category || ""}${t.section ? " · " + t.section : ""}` || "Other";
      if (!bySection.has(k)) bySection.set(k, []);
      bySection.get(k).push(t);
    }
    const done = list.filter((t) => t.done).length;
    const courseBox = el("details.group", { open: byCourse.size === 1 });
    courseBox.append(
      el(
        "summary",
        {},
        el("span.coursename", {}, course),
        el("span.num.muted.meta", {}, `${done}/${list.length} done`)
      )
    );
    for (const [section, items] of bySection) {
      const sdone = items.filter((t) => t.done).length;
      const sec = el("details.group.sub", {});
      sec.append(
        el(
          "summary",
          {},
          el("span", {}, section),
          el("span.num.muted.meta", {}, `${sdone}/${items.length}`)
        ),
        el("div.tasklist", {}, items.map((t) => taskRow(t, root, refresh)))
      );
      courseBox.append(sec);
    }
    wrap.append(courseBox);
  }
  return wrap;
}
