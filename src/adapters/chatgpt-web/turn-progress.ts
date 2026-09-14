export interface ChatGptExternalTurnProgressSnapshot {
  revision: number;
  lastToolBatchRevision: number;
  activeToolCalls: number;
  lastProgressAt?: number;
}

interface ProgressWaiter {
  afterRevision: number;
  resolve: (snapshot: ChatGptExternalTurnProgressSnapshot) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ToolBatchObservationWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ChatGptTurnProgressReader {
  snapshot(): ChatGptExternalTurnProgressSnapshot;
  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot>;
  acknowledgeToolBatch(revision: number): Promise<void>;
}

abstract class ChatGptTurnProgressBroadcaster implements ChatGptTurnProgressReader {
  private readonly waiters = new Set<ProgressWaiter>();

  abstract snapshot(): ChatGptExternalTurnProgressSnapshot;
  abstract acknowledgeToolBatch(revision: number): Promise<void>;

  waitForChange(afterRevision: number, signal?: AbortSignal): Promise<ChatGptExternalTurnProgressSnapshot> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error("ChatGPT external progress revision must be a non-negative safe integer");
    }
    const current = this.snapshot();
    if (current.revision > afterRevision) return Promise.resolve(current);
    if (signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ProgressWaiter = { afterRevision, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          reject(new DOMException("ChatGPT external progress wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  protected notify(snapshot: ChatGptExternalTurnProgressSnapshot): void {
    for (const waiter of [...this.waiters]) {
      if (snapshot.revision <= waiter.afterRevision) continue;
      this.waiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(snapshot);
    }
  }
}

export class ChatGptExternalTurnProgress extends ChatGptTurnProgressBroadcaster {
  private revision = 0;
  private lastToolBatchRevision = 0;
  private observedToolBatchRevision = 0;
  private activeToolCalls = 0;
  private lastProgressAt?: number;
  private readonly toolBatchObservationWaiters = new Set<ToolBatchObservationWaiter>();

  snapshot(): ChatGptExternalTurnProgressSnapshot {
    return {
      revision: this.revision,
      lastToolBatchRevision: this.lastToolBatchRevision,
      activeToolCalls: this.activeToolCalls,
      ...(this.lastProgressAt !== undefined ? { lastProgressAt: this.lastProgressAt } : {}),
    };
  }

  recordToolBatch(count: number, now = Date.now()): number {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("ChatGPT external progress requires a non-empty tool batch");
    }
    this.activeToolCalls += count;
    this.revision += 1;
    this.lastToolBatchRevision = this.revision;
    this.lastProgressAt = now;
    this.notify(this.snapshot());
    return this.lastToolBatchRevision;
  }

  async acknowledgeToolBatch(revision: number): Promise<void> {
    this.assertToolBatchRevision(revision);
    if (revision <= this.observedToolBatchRevision) return;
    this.observedToolBatchRevision = revision;
    for (const waiter of [...this.toolBatchObservationWaiters]) {
      if (waiter.revision > revision) continue;
      this.toolBatchObservationWaiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  waitForToolBatchObservation(revision: number, signal?: AbortSignal): Promise<void> {
    this.assertToolBatchRevision(revision);
    if (this.observedToolBatchRevision >= revision) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(new DOMException("ChatGPT tool-boundary observation aborted", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      const waiter: ToolBatchObservationWaiter = { revision, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.toolBatchObservationWaiters.delete(waiter);
          reject(new DOMException("ChatGPT tool-boundary observation aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.toolBatchObservationWaiters.add(waiter);
    });
  }

  recordToolResult(now = Date.now()): void {
    if (this.activeToolCalls <= 0) {
      throw new Error("ChatGPT external progress received a tool result without an active call");
    }
    this.activeToolCalls -= 1;
    this.revision += 1;
    this.lastProgressAt = now;
    this.notify(this.snapshot());
  }

  private assertToolBatchRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision > this.lastToolBatchRevision) {
      throw new Error("ChatGPT tool-boundary acknowledgement has an invalid batch revision");
    }
  }
}

/** Cross-process mirror of daemon-owned MCP progress for the Launcher browser helper. */
export class ChatGptMirroredTurnProgress extends ChatGptTurnProgressBroadcaster {
  private current: ChatGptExternalTurnProgressSnapshot = {
    revision: 0,
    lastToolBatchRevision: 0,
    activeToolCalls: 0,
  };
  private observedToolBatchRevision = 0;

  constructor(
    private readonly onToolBatchObserved?: (revision: number) => Promise<void> | void,
  ) {
    super();
  }

  snapshot(): ChatGptExternalTurnProgressSnapshot {
    return { ...this.current };
  }

  async acknowledgeToolBatch(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision)
      || revision <= 0
      || revision > this.current.lastToolBatchRevision) {
      throw new Error("ChatGPT mirrored tool-boundary acknowledgement has an invalid batch revision");
    }
    if (revision <= this.observedToolBatchRevision) return;
    await this.onToolBatchObserved?.(revision);
    this.observedToolBatchRevision = revision;
  }

  /** Ignore stale frames, but reject snapshots that advance while contradicting observed history. */
  apply(next: ChatGptExternalTurnProgressSnapshot): boolean {
    assertChatGptTurnProgressSnapshot(next);
    if (next.revision <= this.current.revision) return false;
    if (next.lastToolBatchRevision < this.current.lastToolBatchRevision
      || (next.lastProgressAt === undefined && this.current.lastProgressAt !== undefined)
      || (next.lastProgressAt !== undefined
        && this.current.lastProgressAt !== undefined
        && next.lastProgressAt < this.current.lastProgressAt)) {
      throw new Error("ChatGPT external progress snapshot regressed against the observed state");
    }
    this.current = { ...next };
    this.notify(this.snapshot());
    return true;
  }
}

export function assertChatGptTurnProgressSnapshot(
  value: ChatGptExternalTurnProgressSnapshot,
): void {
  const finiteIndex = (candidate: number): boolean => Number.isSafeInteger(candidate) && candidate >= 0;
  if (!value
    || !finiteIndex(value.revision)
    || !finiteIndex(value.lastToolBatchRevision)
    || !finiteIndex(value.activeToolCalls)
    || value.lastToolBatchRevision > value.revision
    || (value.lastProgressAt !== undefined && !Number.isFinite(value.lastProgressAt))
    || (value.revision > 0 && value.lastProgressAt === undefined)) {
    throw new Error("ChatGPT external progress snapshot is invalid");
  }
}

export function chatGptExternalProgressIsLive(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
  graceMs: number,
): boolean {
  if (!snapshot) return false;
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("ChatGPT external progress liveness inputs are invalid");
  }
  return snapshot.activeToolCalls > 0
    || (snapshot.lastProgressAt !== undefined && now - snapshot.lastProgressAt < graceMs);
}

export function chatGptExternalToolCallsAreInFlight(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
): boolean {
  return (snapshot?.activeToolCalls ?? 0) > 0;
}
