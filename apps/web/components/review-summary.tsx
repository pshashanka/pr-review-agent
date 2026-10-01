import type { Review } from "@pr-review/agent";

/** Read-only view of a finished review. */
export function ReviewSummary({ review }: { review: Review }) {
  return (
    <div className="review">
      <p className="pre">{review.summary}</p>
      <p>
        Verdict: <strong>{review.verdict.replace("_", " ")}</strong> · Tests:{" "}
        <strong>{review.coverage.status.replace("_", " ")}</strong> · {review.findings.length}{" "}
        findings · {review.meta.model}
      </p>
      <ul className="findings">
        {review.findings.map((f) => (
          <li key={f.id}>
            <span className={`badge ${f.severity}`}>{f.severity}</span>{" "}
            <span className="mono">
              {f.path}:{f.line}
            </span>{" "}
            {f.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
