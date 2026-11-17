import { describe, expect, it, vi } from "vitest";
import { RunRegistry } from "@/lib/run-registry";
import type { Subscriber, WebEvent } from "@/lib/run-registry";

const { runReview } = vi.hoisted(() => ({
  runReview: vi.fn<(graph: unknown, threadId: string, step: unknown) => AsyncGenerator<WebEvent>>(),
}));

vi.mock("@/lib/agent-module", () => ({
  agentModule: () => Promise.resolve({ runReview }),
}));

const progress = (message: string): WebEvent => ({
  type: "progress",
  event: { type: "status", node: "loadChange", message },
});

/** Emits three events, then stays live so the buffered events can be replayed. */
async function* liveRun(): AsyncGenerator<WebEvent> {
  yield progress("a");
  yield progress("b");
  yield progress("c");
  await new Promise<never>(() => {});
}

function listener(): { events: { id: number; event: WebEvent }[]; subscriber: Subscriber } {
  const events: { id: number; event: WebEvent }[] = [];
  return {
    events,
    subscriber: {
      onEvent: (id, event) => events.push({ id, event }),
      onClose: () => {},
    },
  };
}

describe("RunRegistry", () => {
  it("assigns monotonic ids and replays only events after Last-Event-ID", async () => {
    const registry = new RunRegistry();
    runReview.mockReturnValue(liveRun());
    registry.start("thread", {} as never, "agent-thread", { resume: true });

    const first = listener();
    const unsubscribe = registry.subscribe("thread", first.subscriber, 0);
    expect(unsubscribe).not.toBeNull();
    await vi.waitFor(() => expect(first.events).toHaveLength(3));

    expect(first.events.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(first.events.map(({ event }) => event)).toEqual([
      progress("a"),
      progress("b"),
      progress("c"),
    ]);

    // A reconnecting client resumes after the last id it saw: only id 3 replays.
    const second = listener();
    registry.subscribe("thread", second.subscriber, 2);
    expect(second.events).toEqual([{ id: 3, event: progress("c") }]);

    // An id at or beyond the last event replays nothing.
    const third = listener();
    registry.subscribe("thread", third.subscriber, 3);
    expect(third.events).toEqual([]);

    unsubscribe?.();
  });
});
