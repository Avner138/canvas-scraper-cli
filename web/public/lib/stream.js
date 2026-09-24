import { api } from "./api.js";

/**
 * Watches one job's event stream.
 *
 * Shared by the Run and Sessions screens so there is one place that knows the
 * SSE shape. The stream is multiplexed across all jobs — HTTP/1.1 allows six
 * connections per origin and a nine-minute scrape outlives any one screen — so
 * events for other jobs are filtered out here rather than at the server.
 *
 * @param {string} jobId
 * @param {object} handlers
 * @param {(record: object) => void} [handlers.onLog]
 * @param {(progress: object) => void} [handlers.onProgress]
 * @param {(prompt: {promptId: string|null, message: string|null}) => void} [handlers.onPrompt]
 * @param {(job: object) => void} [handlers.onEnd] fired once, when it stops running
 * @returns {() => void} close
 */
export function watchJob(jobId, handlers = {}) {
  const token = window.__token || "";
  let es;
  try {
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  } catch (e) {
    return () => {};
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      es.close();
    } catch (e) {
      /* already gone */
    }
  };

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    // `hello` and anything for another job are not ours.
    if (msg.jobId && msg.jobId !== jobId) return;
    if (msg.type === "log" && handlers.onLog) handlers.onLog(msg.record);
    if (msg.type === "progress" && handlers.onProgress) handlers.onProgress(msg.progress);
    if (msg.type === "prompt" && handlers.onPrompt) {
      handlers.onPrompt({ promptId: msg.promptId, message: msg.message });
    }
    if (msg.type === "job" && msg.job && msg.job.id === jobId && msg.job.status !== "running") {
      close();
      if (handlers.onEnd) handlers.onEnd(msg.job);
    }
  };

  // A job can finish between the request that found it and this subscription,
  // in which case no further event will ever arrive. Ask once, directly.
  api(`/api/jobs/${jobId}`)
    .then((job) => {
      if (job && job.status !== "running" && !closed) {
        close();
        if (handlers.onEnd) handlers.onEnd(job);
      } else if (job && job.prompt && handlers.onPrompt) {
        // A prompt raised before we subscribed is still waiting for an answer.
        handlers.onPrompt(job.prompt);
      }
    })
    .catch(() => {});

  return close;
}

/** Answers a prompt a job is blocked on. */
export function replyPrompt(jobId, promptId) {
  return api(`/api/jobs/${jobId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ promptId }),
  });
}
