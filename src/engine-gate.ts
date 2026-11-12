/**
 * Readers/writer gate around the engine.
 *
 * - Engine-backed tool calls hold a SHARED slot for their whole duration
 *   (BuildSession's own mutex still serialises them against each other).
 * - Engine swaps (configure_pob_path, reload_engine) take the gate
 *   EXCLUSIVELY: new tool calls queue behind them, and the swap waits until
 *   every running call has finished before it touches the bridge. So a swap
 *   never disposes a bridge with a command in flight, and no call can observe
 *   the half-swapped state.
 * Writer-preferring: once a swap is waiting, new calls wait for it.
 */
export class EngineGate {
  private active = 0;
  private exclusiveHeld = false;
  private exclusiveWaiting = 0;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private sharedWaiters: Array<() => void> = [];
  private drainWaiters: Array<() => void> = [];

  /** True while a swap is running or queued. */
  get busy(): boolean {
    return this.exclusiveHeld || this.exclusiveWaiting > 0;
  }

  /** Number of tool calls currently holding the gate. */
  get activeCalls(): number {
    return this.active;
  }

  async enterShared(): Promise<() => void> {
    while (this.busy) await new Promise<void>((r) => this.sharedWaiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (this.active === 0) flush(this.drainWaiters);
    };
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.exclusiveWaiting++;
    const prev = this.exclusiveTail;
    let done!: () => void;
    this.exclusiveTail = new Promise<void>((r) => (done = r));
    let held = false;
    try {
      await prev;
      while (this.active > 0) await new Promise<void>((r) => this.drainWaiters.push(r));
      this.exclusiveWaiting--;
      this.exclusiveHeld = held = true;
      return await fn();
    } finally {
      if (held) this.exclusiveHeld = false;
      else this.exclusiveWaiting--;
      done();
      if (!this.busy) flush(this.sharedWaiters);
    }
  }
}

function flush(list: Array<() => void>): void {
  for (const wake of list.splice(0)) wake();
}
