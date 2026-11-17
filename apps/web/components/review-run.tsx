"use client";

import type { ReviewDecision } from "@pr-review/agent";
import { useCallback, useEffect, useReducer, useState } from "react";
import type { WebEvent } from "@/lib/run-registry";
import { INITIAL_VIEW, STEPS, reduceRun } from "@/lib/run-view";
import { ApprovalPanel } from "./approval-panel";
import { ReviewSummary } from "./review-summary";

export function ReviewRun({ threadId }: { threadId: string }) {
  const [view, dispatch] = useReducer(reduceRun, INITIAL_VIEW);
  // Bumped to reconnect after we trigger a new run (decision, resume).
  const [connection, setConnection] = useState(0);
  // True while a decision/resume request is in flight, so controls can't be
  // double-clicked into a 409.
  const [submitting, setSubmitting] = useState(false);
  // Error from the last decision/resume request, shown by the control that
  // sent it. This is not a run failure, so it's kept apart from view.error.
  const [actionError, setActionError] = useState<string | null>(null);
  const base = `/api/reviews/${encodeURIComponent(threadId)}`;

  useEffect(() => {
    // The server prefixes each buffered event with an `id:` line, so the
    // browser's built-in EventSource retry resumes from the last seen id after
    // a dropped connection instead of replaying events the page already has.
    const source = new EventSource(`${base}/events`);
    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as WebEvent;
      dispatch(event);
      if (event.type === "snapshot") {
        // A snapshot is a fresh read of the checkpoint: clear any stale action
        // error and re-enable the controls. If the run is no longer live the
        // server has closed the stream, so stop the automatic reconnection.
        setSubmitting(false);
        setActionError(null);
        if (!event.live) source.close();
      } else if (event.type === "finished" || event.type === "failed") {
        // The run ended; the server will close the stream too.
        setSubmitting(false);
        source.close();
      }
    };
    return () => source.close();
  }, [base, connection]);

  const post = useCallback(
    async (path: string, body?: unknown) => {
      setSubmitting(true);
      setActionError(null);
      try {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? null : JSON.stringify(body),
        });
        if (!response.ok) {
          setActionError(await describeHttpError(response));
          setSubmitting(false);
          return;
        }
        // Keep submitting until the reconnected stream's snapshot arrives: the
        // decision is applied asynchronously, so the controls must not become
        // clickable again (and double-click into a 409) in the meantime.
        setConnection((c) => c + 1);
      } catch {
        setActionError("Could not reach the server. Try again.");
        setSubmitting(false);
      }
    },
    [base],
  );

  const status = view.status;
  const files = Object.entries(view.files);
  return (
    <section className="run">
      <h1>Review</h1>
      <p className="muted mono">{threadId}</p>

      <div className="columns">
        <ol className="card steps">
          {STEPS.map(([name, label]) => (
            <li key={name} className={view.finished[name] ? "done" : ""}>
              {label}
            </li>
          ))}
        </ol>

        <div className="activity">
          {files.length > 0 && (
            <div className="card">
              <h2>Files</h2>
              <ul className="files">
                {files.map(([path, file]) => (
                  <li key={path} className={file.state}>
                    <span className="mono">{path}</span>{" "}
                    {file.state === "running" && <span className="muted">analyzing…</span>}
                    {file.state === "done" && <span>{file.findings} findings</span>}
                    {file.state === "failed" && <span className="error">{file.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.live && view.thinking !== null && (
            <div className="card thinking">
              <h2>Thinking · {view.thinking.label}</h2>
              <p>{view.thinking.text}</p>
            </div>
          )}
          {view.log.length > 0 && (
            <ul className="card log">
              {view.log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {view.error !== null && <p className="error card">Run failed: {view.error}</p>}

      {actionError !== null && (
        <p className="error card">
          Could not apply that action: {actionError}{" "}
          <button className="secondary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      )}

      {status?.state === "running" && !view.live && (
        <div className="card">
          <p>
            This run stopped before finishing (for example, the server restarted). It can continue
            from its last checkpoint.
          </p>
          <button onClick={() => void post("/resume")} disabled={submitting}>
            {submitting ? "Resuming…" : "Resume"}
          </button>
        </div>
      )}

      {status?.state === "awaiting_approval" && !view.live && (
        <ApprovalPanel
          request={status.request}
          disabled={submitting}
          onDecide={(decision: ReviewDecision) => void post("/decision", decision)}
        />
      )}

      {status?.state === "published" && (
        <div className="card">
          <p className="ok">
            {status.published.alreadyPosted
              ? "This review was already posted, so nothing new was posted:"
              : status.published.kind === "github"
                ? "Review posted to GitHub as a comment:"
                : "Review written to a file:"}{" "}
            {status.published.kind === "github" ? (
              <a href={status.published.location}>{status.published.location}</a>
            ) : (
              <span className="mono">{status.published.location}</span>
            )}
          </p>
          <ReviewSummary review={status.review} />
        </div>
      )}

      {status?.state === "rejected" && (
        <div className="card">
          <p>Rejected. Nothing was posted.</p>
          <p className="muted">Reason: {status.reason}</p>
        </div>
      )}
    </section>
  );
}

/** Turns a failed HTTP response into a message without crashing on a non-JSON body. */
async function describeHttpError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") return body.error;
  } catch {
    // Not JSON (a proxy's HTML 502, for example): fall back to the status.
  }
  return `Request failed (${response.status})`;
}
