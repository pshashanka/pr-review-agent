"use client";

import type { ReviewDecision } from "@pr-review/agent";
import { useCallback, useEffect, useReducer, useState } from "react";
import type { WebEvent } from "@/lib/run-registry";
import { INITIAL_VIEW, STEPS, reduceRun, type RunView } from "@/lib/run-view";
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
    let source: EventSource | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      source = new EventSource(`${base}/events`);
      source.onmessage = (message: MessageEvent<string>) => {
        dispatch(JSON.parse(message.data) as WebEvent);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        // The server closes the stream when the run pauses or ends. A dropped
        // connection mid-run (sleep, restart, network blip) must not leave the
        // page thinking it is still live with no stream: reconnect while the
        // run is live, otherwise read the final status from the checkpoint.
        void fetch(base)
          .then((r) => r.json() as Promise<{ status: RunView["status"]; live: boolean }>)
          .then(({ status, live }) => {
            if (stopped) return;
            if (status !== null) dispatch({ type: "snapshot", status, live });
            if (live) connect();
          })
          .catch(() => {
            if (!stopped) setTimeout(connect, 1_000);
          });
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
    };
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
          const { error } = (await response.json()) as { error?: string };
          setActionError(error ?? `Request failed (${response.status})`);
          return;
        }
        setConnection((c) => c + 1);
      } catch {
        setActionError("Could not reach the server. Try again.");
      } finally {
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
