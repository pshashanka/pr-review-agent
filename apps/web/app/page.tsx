import { NewReviewForm } from "@/components/new-review-form";
import { getConfig } from "@/lib/agents";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const config = getConfig();
  const repos = [...config.repos.keys()];
  return (
    <section>
      <h1>Review a change</h1>
      {config.demo && (
        <p className="banner">
          Demo mode: reviews come from an offline heuristic, not Claude. Unset PR_REVIEW_DEMO for
          real reviews.
        </p>
      )}
      {repos.length === 0 ? (
        <p>
          No repositories configured. Set <code>PR_REVIEW_REPOS=name=/path/to/repo</code> and
          restart.
        </p>
      ) : (
        <NewReviewForm repos={repos} />
      )}
    </section>
  );
}
