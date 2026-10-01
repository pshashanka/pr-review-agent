import { ReviewRun } from "@/components/review-run";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewRun threadId={decodeURIComponent(id)} />;
}
