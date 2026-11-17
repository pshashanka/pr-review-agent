import type { RunEvent, RunStatus, runReview } from "@pr-review/agent";
import { agentModule } from "./agent-module";

type Graph = Parameters<typeof runReview>[0];
type Step = Parameters<typeof runReview>[2];

/** Events sent to the browser: the agent's run events, plus snapshot and failure. */
export type WebEvent =
  | RunEvent
  | { type: "snapshot"; status: RunStatus; live: boolean }
  | { type: "failed"; error: string };

const MAX_BUFFERED_THINKING = 500;

export interface Subscriber {
  /** `id` is the event's sequence number, used for Last-Event-ID replay. */
  onEvent(id: number, event: WebEvent): void;
  /** The run ended (finished, paused or failed); no more events will come. */
  onClose(): void;
}

interface LiveRun {
  events: { id: number; event: WebEvent }[];
  /** Sequence number of the next published event; starts at 1 so 0 means "none seen yet". */
  nextId: number;
  thinkingBuffered: number;
  subscribers: Set<Subscriber>;
}

/**
 * Runs in this server process, with their events buffered so a browser that
 * connects late (or reconnects) can replay them. The checkpoint, not this
 * registry, is the source of truth: after a restart the registry is empty
 * and status comes from getStatus.
 */
export class RunRegistry {
  readonly #runs = new Map<string, LiveRun>();

  isLive(threadId: string): boolean {
    return this.#runs.has(threadId);
  }

  /** Starts a run in the background. Throws if one is already live for the thread. */
  start(threadId: string, graph: Graph, agentThreadId: string, step: Step): void {
    if (this.#runs.has(threadId)) throw new Error("A run is already in progress for this review.");
    const run: LiveRun = { events: [], nextId: 1, thinkingBuffered: 0, subscribers: new Set() };
    this.#runs.set(threadId, run);

    const publish = (event: WebEvent) => {
      const id = run.nextId++;
      if (
        event.type === "progress" &&
        event.event.type === "llm" &&
        event.event.progress.type === "thinking"
      ) {
        if (run.thinkingBuffered >= MAX_BUFFERED_THINKING) {
          for (const subscriber of run.subscribers) subscriber.onEvent(id, event);
          return; // send live, but stop buffering for replay
        }
        run.thinkingBuffered++;
      }
      run.events.push({ id, event });
      for (const subscriber of run.subscribers) subscriber.onEvent(id, event);
    };

    void (async () => {
      try {
        const { runReview } = await agentModule();
        for await (const event of runReview(graph, agentThreadId, step)) publish(event);
      } catch (error) {
        publish({ type: "failed", error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.#runs.delete(threadId);
        for (const subscriber of run.subscribers) subscriber.onClose();
      }
    })();
  }

  /**
   * Replays a live run's buffered events after `lastEventId`, then forwards
   * new ones until it ends. Returns an unsubscribe function, or null if
   * nothing is running.
   */
  subscribe(threadId: string, subscriber: Subscriber, lastEventId = 0): (() => void) | null {
    const run = this.#runs.get(threadId);
    if (run === undefined) return null;
    for (const { id, event } of run.events) {
      if (id > lastEventId) subscriber.onEvent(id, event);
    }
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }
}

const holder = globalThis as unknown as { __prReviewRuns?: RunRegistry };

export function getRegistry(): RunRegistry {
  holder.__prReviewRuns ??= new RunRegistry();
  return holder.__prReviewRuns;
}
