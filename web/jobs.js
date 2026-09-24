import { spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { randomUUID } from "crypto";

/**
 * Runs one job at a time in a child process, and streams what it says.
 *
 * One at a time is not a simplification, it is a correctness requirement:
 * report.current, manifest.courseDir, helpers.printer, helpers.progressSink,
 * helpers._createdDirs and the catalog are all module-level singletons that
 * assume a strictly sequential scrape, and two runs into one output tree would
 * additionally race on .part files and manifest.save(). So a second start is
 * refused with the id of the job already running, rather than queued.
 */

const SENTINEL = "\u0000CSEVT ";
const LOG_CAP = 4000; // ring buffer per job

/**
 * The argv that re-launches this program as a job child.
 *
 * Only the script path, because job mode is signalled by an environment
 * variable rather than a subcommand. Three runtimes diverge on argv and the
 * failure is silent — the binary builds, --help passes, and jobs simply never
 * start:
 *   node index.js        argv[1] is the script, so it must be passed through
 *   node dist/app.mjs    argv[1] is the bundle, likewise
 *   packaged binary      pkg's bootstrap claims the first argument as a script
 *                        path to run, so anything passed there never reaches
 *                        our code at all
 */
export function childArgv() {
  return process.pkg ? [] : [process.argv[1]];
}

/** Where a finished job's log is kept, so a reload can still read it. */
function logDir() {
  return path.join(os.tmpdir(), "canvas-scraper-jobs");
}

export class JobRunner {
  constructor() {
    this.jobs = new Map();
    this.active = null;
    this.listeners = new Set();
    this.seq = 0;
  }

  /** Subscribes to the event stream. Returns an unsubscribe function. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Broadcasts one event, stamped with a monotonic id for SSE replay. */
  _emit(event) {
    const stamped = { ...event, seq: ++this.seq };
    for (const fn of this.listeners) {
      try {
        fn(stamped);
      } catch (e) {
        /* a broken client must not stop the job */
      }
    }
    return stamped;
  }

  /** The job list, newest first, without their logs. */
  list() {
    return [...this.jobs.values()]
      .map(({ log, child, ...rest }) => ({ ...rest, logLines: log.length }))
      .sort((a, b) => (a.started < b.started ? 1 : -1));
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const { log, child, ...rest } = job;
    return { ...rest, logLines: log.length };
  }

  /** A slice of a job's log, for a client that reloaded mid-run. */
  logSlice(id, after = 0, limit = 1000) {
    const job = this.jobs.get(id);
    if (!job) return [];
    return job.log.slice(Math.max(0, after), Math.max(0, after) + limit);
  }

  /**
   * Starts a job.
   * @param {object} spec {kind, url, options, cookies}
   * @returns {{id: string}|{busy: string}}
   */
  start(spec) {
    if (this.active && this.jobs.get(this.active)?.status === "running") {
      return { busy: this.active };
    }
    const id = randomUUID().slice(0, 8);
    const job = {
      id,
      kind: spec.kind || "scrape",
      url: spec.url || "",
      output: spec.options?.output || "",
      status: "starting",
      started: new Date().toISOString(),
      ended: null,
      exitCode: null,
      error: null,
      summary: null,
      progress: {},
      prompt: null,
      log: [],
      child: null,
    };
    this.jobs.set(id, job);
    this.active = id;

    // The spec travels in the environment: no argv quoting to get wrong, no
    // length limit, and nothing for a packaged runtime to reinterpret. IPC is
    // still opened, but only for the messages that must flow back the other
    // way — cancel, and the login flow's prompts.
    const encoded = Buffer.from(JSON.stringify(spec)).toString("base64");
    let child;
    try {
      child = spawn(process.execPath, childArgv(), {
        cwd: spec.cwd || process.cwd(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, CANVAS_SCRAPER_JOB: encoded },
        // Its own process group, so a hard kill can take the whole tree —
        // otherwise a wedged Chrome outlives the job that started it.
        detached: process.platform !== "win32",
      });
    } catch (e) {
      job.status = "failed";
      job.error = e.message;
      job.ended = new Date().toISOString();
      this.active = null;
      this._emit({ type: "job", job: this.get(id) });
      return { id };
    }

    job.child = child;
    job.status = "running";
    try {
      child.send({ type: "run", spec });
    } catch (e) {
      // No IPC channel: the child reads the base64 argv tail instead.
    }

    const onEvent = (msg) => this._onChildEvent(job, msg);
    child.on("message", onEvent);

    // stdout carries both the sentinel events (when IPC is unavailable) and
    // the scrapers' own console.log lines, which are never routed through
    // helpers.print.
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith(SENTINEL)) {
          try {
            onEvent(JSON.parse(line.slice(SENTINEL.length)));
          } catch (e) {
            /* ignore a malformed line */
          }
        } else if (line.trim()) {
          this._log(job, { type: "INFO", name: "", message: line });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this._log(job, { type: "ERROR", name: "STDERR", message: text });
    });

    child.on("error", (e) => {
      job.error = e.message;
    });
    child.on("close", (code) => {
      job.exitCode = code;
      job.ended = new Date().toISOString();
      // 130 is the graceful-cancel path: runScrape's SIGINT handler flushed
      // every report and exited. Partial results are on disk, so this is a
      // cancellation rather than a failure.
      job.status = code === 0 ? "done" : code === 130 ? "cancelled" : "failed";
      if (job.status === "failed" && !job.error) job.error = `exited ${code}`;
      job.child = null;
      if (this.active === job.id) this.active = null;
      this._persist(job);
      this._emit({ type: "job", job: this.get(job.id) });
    });

    this._emit({ type: "job", job: this.get(id) });
    return { id };
  }

  /** Records a log line, capped so a long run cannot exhaust memory. */
  _log(job, record) {
    job.log.push(record);
    if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
    this._emit({ type: "log", jobId: job.id, record });
  }

  _onChildEvent(job, msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "log") return this._log(job, msg.record);
    if (msg.type === "progress") {
      job.progress = { ...job.progress, ...summarizeProgress(msg.event) };
      return this._emit({ type: "progress", jobId: job.id, event: msg.event, progress: job.progress });
    }
    if (msg.type === "prompt") {
      job.prompt = { promptId: msg.promptId, message: msg.message };
      return this._emit({ type: "prompt", jobId: job.id, ...job.prompt });
    }
    if (msg.type === "done") {
      job.summary = msg.summary || null;
      job.prompt = null;
      return;
    }
    if (msg.type === "error") {
      job.error = msg.error;
      return;
    }
  }

  /** Answers a prompt the login flow is waiting on. */
  reply(id, promptId) {
    const job = this.jobs.get(id);
    if (!job || !job.child) return false;
    try {
      job.child.send({ type: "prompt-reply", promptId });
      job.prompt = null;
      this._emit({ type: "prompt", jobId: id, promptId: null, message: null });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Cancels a job.
   *
   * Asks first: the child turns that into its own SIGINT, which runScrape
   * already handles by flushing every report and exiting 130 — so a cancelled
   * run keeps what it collected. A hard kill of the whole process group
   * follows only if it has not gone in ten seconds, so a wedged Chrome cannot
   * outlive it.
   */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || !job.child) return false;
    job.status = "cancelling";
    this._emit({ type: "job", job: this.get(id) });
    try {
      job.child.send({ type: "cancel" });
    } catch (e) {
      /* fall through to the signal */
    }
    try {
      if (process.platform !== "win32") process.kill(-job.child.pid, "SIGINT");
    } catch (e) {
      /* the group may already be gone */
    }
    setTimeout(() => {
      if (!job.child) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(job.child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(-job.child.pid, "SIGKILL");
        }
      } catch (e) {
        /* already gone */
      }
    }, 10000).unref();
    return true;
  }

  /** Writes a finished job's log beside the others, best-effort. */
  _persist(job) {
    try {
      fs.mkdirSync(logDir(), { recursive: true });
      fs.writeFileSync(
        path.join(logDir(), `${job.id}.json`),
        JSON.stringify({ ...this.get(job.id), log: job.log }, null, 2)
      );
    } catch (e) {
      /* logs are a convenience */
    }
  }
}

/**
 * Folds a raw progress event into a flat shape a UI can render directly.
 *
 * The byte events arrive every 150ms per download, so the UI reads this
 * snapshot rather than replaying the stream.
 */
export function summarizeProgress(event) {
  if (!event) return {};
  if (event.type === "start") return { mode: event.mode, courses: event.total, courseIndex: 0 };
  if (event.type === "course") {
    return { courseIndex: event.index, courses: event.total, course: event.name, phase: null };
  }
  if (event.type === "phase") return { phase: event.label };
  if (event.type === "course-end") return { phase: null };
  if (event.type === "done") return { finished: true, phase: null, download: null };
  if (event.type === "download") {
    const { scope, phase, name, received, total, percent } = event;
    if (phase === "done") return { download: null };
    // Transcription runs alongside a download, so it gets its own slot rather
    // than fighting for the same bar.
    const slot = scope === "transcribe" ? "transcribe" : "download";
    return { [slot]: { scope, name, received, total, percent } };
  }
  return {};
}

export default { JobRunner, summarizeProgress, childArgv };
