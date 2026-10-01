"use client";

import { useRouter } from "next/navigation";
import { useState, type SubmitEvent } from "react";

export function NewReviewForm({ repos }: { repos: string[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const pr = field("pr");
    const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(pr);
    if (pr !== "" && match === null) {
      setError("Pull request must look like owner/repo#123.");
      return;
    }

    setSubmitting(true);
    setError(null);
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: field("repo"),
        base: field("base"),
        head: field("head") || "HEAD",
        pullRequest:
          match === null ? null : { owner: match[1], repo: match[2], number: Number(match[3]) },
      }),
    });
    const body = (await response.json()) as { threadId?: string; error?: string };
    if (!response.ok || body.threadId === undefined) {
      setError(body.error ?? `Request failed (${response.status})`);
      setSubmitting(false);
      return;
    }
    router.push(`/reviews/${encodeURIComponent(body.threadId)}`);
  }

  return (
    <form className="card form" onSubmit={(e) => void onSubmit(e)}>
      <label>
        Repository
        <select name="repo" required>
          {repos.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label>
        Base
        <input name="base" defaultValue="main" required />
      </label>
      <label>
        Head
        <input name="head" defaultValue="HEAD" />
      </label>
      <label>
        Pull request <span className="muted">(optional, posts to GitHub)</span>
        <input name="pr" placeholder="owner/repo#123" />
      </label>
      {error !== null && <p className="error">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Starting…" : "Start review"}
      </button>
    </form>
  );
}
