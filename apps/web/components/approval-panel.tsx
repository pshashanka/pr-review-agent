"use client";

import type { ApprovalRequest, ReviewDecision } from "@pr-review/agent";
import { useState } from "react";

type Verdict = ApprovalRequest["review"]["verdict"];

/**
 * The human gate. Approving unchanged sends "approve"; any change sends an
 * "edit" with the reworded findings that are still ticked. Findings can't be
 * added or moved here, so every inline comment stays anchored to the diff.
 */
export function ApprovalPanel({
  request,
  onDecide,
}: {
  request: ApprovalRequest;
  onDecide: (decision: ReviewDecision) => void;
}) {
  const { review } = request;
  const [summary, setSummary] = useState(review.summary);
  const [verdict, setVerdict] = useState<Verdict>(review.verdict);
  const [findings, setFindings] = useState(() =>
    review.findings.map((f) => ({ ...f, keep: true })),
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const edited =
    summary !== review.summary ||
    verdict !== review.verdict ||
    findings.some((f, i) => {
      const original = review.findings[i];
      return (
        !f.keep || original === undefined || f.title !== original.title || f.body !== original.body
      );
    });

  function update(index: number, patch: Partial<(typeof findings)[number]>) {
    setFindings((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function approve() {
    if (!edited) {
      onDecide({ action: "approve" });
      return;
    }
    onDecide({
      action: "edit",
      summary,
      verdict,
      findings: findings
        .filter((f) => f.keep)
        .map(({ id, title, body, suggestion }) => ({ id, title, body, suggestion })),
    });
  }

  return (
    <div className="card approval">
      <h2>Review ready for approval</h2>
      <p className="muted">
        Nothing is posted until you approve. {review.meta.filesReviewed.length} files reviewed
        {review.meta.filesSkipped.length > 0 && `, ${review.meta.filesSkipped.length} skipped`}
        {review.meta.fileErrors.length > 0 && `, ${review.meta.fileErrors.length} failed`}.
      </p>

      <label>
        Summary
        <textarea value={summary} rows={4} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <label>
        Verdict
        <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
          <option value="approve">approve</option>
          <option value="comment">comment</option>
          <option value="request_changes">request changes</option>
        </select>
      </label>

      {review.risks.length > 0 && (
        <>
          <h3>Risks</h3>
          <ul>
            {review.risks.map((r, i) => (
              <li key={i}>
                <span className={`badge ${r.level}`}>{r.level}</span> {r.kind}: {r.rationale}{" "}
                <span className="muted mono">{r.paths.join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Tests: {review.coverage.status.replace("_", " ")}</h3>
      <p className="pre">{review.coverage.notes}</p>

      <h3>Findings ({findings.filter((f) => f.keep).length})</h3>
      {findings.length === 0 && <p className="muted">No findings.</p>}
      {findings.map((f, i) => (
        <div key={f.id} className={`finding ${f.keep ? "" : "dropped"}`}>
          <label className="inline">
            <input
              type="checkbox"
              checked={f.keep}
              onChange={(e) => update(i, { keep: e.target.checked })}
            />
            <span className={`badge ${f.severity}`}>{f.severity}</span>
            <span className="mono">
              {f.path}:{f.line}
            </span>
            {!f.inline && <span className="muted">(not on a diff line; goes in the summary)</span>}
          </label>
          <input
            value={f.title}
            onChange={(e) => update(i, { title: e.target.value })}
            disabled={!f.keep}
          />
          <textarea
            value={f.body}
            rows={3}
            onChange={(e) => update(i, { body: e.target.value })}
            disabled={!f.keep}
          />
          {f.suggestion !== null && <pre className="suggestion">{f.suggestion}</pre>}
        </div>
      ))}

      {rejecting ? (
        <div className="actions">
          <input
            placeholder="Why reject?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="danger"
            onClick={() => onDecide({ action: "reject", reason: reason.trim() || "Rejected" })}
          >
            Confirm reject
          </button>
          <button className="secondary" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="actions">
          <button onClick={approve}>{edited ? "Approve with edits" : "Approve and publish"}</button>
          <button className="secondary" onClick={() => setRejecting(true)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
