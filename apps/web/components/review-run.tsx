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
  const base = `/api/reviews/${encodeURIComponent(threadId)}`;

  useEffect(() => {
    const source = new EventSource(`${base}/events`);
    source.onmessage = (message: MessageEvent<string>) => {
      dispatch(JSON.parse(message.data) as WebEvent);
    };
    // The server closes the stream when the run pauses or ends. Don't let
    // EventSource reconnect; read the final status from the checkpoint instead.
    source.onerror = () => {
      source.close();
      void fetch(base)
        .then((r) => r.json() as Promise<{ status: RunView["status"]; live: boolean }>)
        .then(({ status, live }) => {
          if (status !== null) dispatch({ type: "snapshot", status, live });
        });
    };
    return () => {
      source.close();
    };
  }, [base, connection]);

  const post = useCallback(
    async (path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
      });
      if (!response.ok) {
        const { error } = (await response.json()) as { error?: string };
        dispatch({ type: "failed", error: error ?? `Request failed (${response.status})` });
        return;
      }
      setConnection((c) => c + 1);
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

      {status?.state === "running" && !view.live && (
        <div className="card">
          <p>
            This run stopped before finishing (for example, the server restarted). It can continue
            from its last checkpoint.
          </p>
          <button onClick={() => void post("/resume")}>Resume</button>
        </div>
      )}

      {status?.state === "awaiting_approval" && !view.live && (
        <ApprovalPanel
          request={status.request}
          onDecide={(decision: ReviewDecision) => void post("/decision", decision)}
        />
      )}

      {status?.state === "published" && (
        <div className="card">
          <p className="ok">
            {status.published.alreadyPosted ? "Already published" : "Published"}:{" "}
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
          <p>Rejected: {status.reason}</p>
        </div>
      )}
    </section>
  );
}
