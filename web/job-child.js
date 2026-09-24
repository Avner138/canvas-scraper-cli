/**
 * The job child: one scrape (or dry run) per process.
 *
 * Scrapes do not run inside the server, for three reasons that are each on
 * their own sufficient:
 *
 *  - runScrape installs unhandledRejection and uncaughtException handlers
 *    whose handler calls process.exit(1). In-process, a single unowned
 *    Puppeteer rejection would kill the server and take the UI down mid-run.
 *  - helpers.setPrinter and setProgressSink are global, so a second consumer
 *    silently steals log routing from the first.
 *  - runScrape mutates process.env.config and several module-level flags.
 *
 * In a child, all of that is contained and process.exit becomes the normal way
 * a job ends rather than a hazard. It also means cancellation needs nothing
 * new: runScrape already registers a SIGINT handler that flushes every report
 * and exits 130, and `process.emit("SIGINT")` invokes it synchronously on
 * every platform — including Windows, which cannot receive a real SIGINT.
 */

const SENTINEL = "\u0000CSEVT ";

/**
 * Sends an event to the parent.
 *
 * IPC when it is wired, and a stdout sentinel when it is not. The fallback is
 * here from the start rather than retrofitted, because whether Node's IPC
 * channel survives the pkg bootstrap is exactly the kind of thing that differs
 * between running from source, from the bundle, and from the binary — and the
 * failure mode is silent: jobs simply never report.
 */
function emit(msg) {
  try {
    if (process.send) process.send(msg);
    else process.stdout.write(SENTINEL + JSON.stringify(msg) + "\n");
  } catch (e) {
    /* a dead parent must not crash the job */
  }
}

/** Errors do not survive JSON, so flatten before sending. */
function flatten(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || String(value);
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

export async function runJob() {
  // Imported lazily so `__job` costs nothing when the parent is just serving.
  const { runScrape } = await import("../core/scrape.js");
  const { runLogin } = await import("../core/login.js");

  // The spec comes from the environment, which every runtime reads the same
  // way — unlike argv, which a packaged binary's bootstrap claims first.
  let spec;
  try {
    spec = JSON.parse(Buffer.from(process.env.CANVAS_SCRAPER_JOB, "base64").toString("utf8"));
  } catch (e) {
    emit({ type: "error", error: "no job spec" });
    process.exit(2);
  }

  const cancel = () => {
    // runScrape's own SIGINT handler flushes the reports and exits 130. Going
    // through it rather than killing the process is what makes a cancelled run
    // still leave its partial results on disk.
    emit({ type: "log", record: { type: "WARNING", name: "CANCEL", message: "Stopping…" } });
    process.emit("SIGINT");
  };
  process.on("message", (m) => {
    if (m && m.type === "cancel") cancel();
  });

  const hooks = {
    onLog: (record) =>
      emit({
        type: "log",
        record: {
          type: record.type,
          name: record.name,
          message: record.message,
          indent: record.indent,
          additional: flatten(record.additional),
        },
      }),
    onProgress: (event) => emit({ type: "progress", event }),
  };

  try {
    if (spec.kind === "noop") {
      // Exists only for `app --selftest`: proves the parent can launch this
      // executable as a child, hand it a spec and hear back, without any
      // network, browser or credentials.
      emit({ type: "log", record: { type: "NOTE", name: "SELFTEST", message: "child alive" } });
      emit({ type: "done", summary: { kind: "noop" } });
      process.exit(0);
    }
    if (spec.kind === "login") {
      await runLogin(spec.url, {
        cookies: spec.cookies,
        loginMode: spec.loginMode || "fresh",
        logger: (msg) => emit({ type: "log", record: { type: "NOTE", name: "LOGIN", message: msg } }),
        // Each prompt gets an id, because there is more than one: the flow asks
        // again after checking for Panopto and Study.Net sessions.
        prompt: (message) =>
          new Promise((resolve) => {
            const promptId = `p${Date.now()}`;
            const onReply = (m) => {
              if (m && m.type === "prompt-reply" && m.promptId === promptId) {
                process.off("message", onReply);
                resolve();
              }
            };
            process.on("message", onReply);
            emit({ type: "prompt", promptId, message });
          }),
      });
      emit({ type: "done", summary: { kind: "login", cookies: spec.cookies } });
    } else {
      const summary = await runScrape(spec.url, spec.options, hooks);
      emit({ type: "done", summary });
    }
  } catch (e) {
    emit({ type: "error", error: e.message || String(e) });
    process.exit(1);
  }
  process.exit(0);
}

export default { runJob };
