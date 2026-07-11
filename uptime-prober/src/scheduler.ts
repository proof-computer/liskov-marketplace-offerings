export interface TickContext {
  sequence: number;
  scheduledAtMs: number;
  startedAtMs: number;
  lagMs: number;
}

export interface SchedulerOptions {
  cadenceMs: number;
  tick(context: TickContext): Promise<void>;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface SchedulerHandle {
  stop(): Promise<void>;
  done: Promise<void>;
}

/** Serialized fixed-cadence scheduler. Missed slots are skipped; ticks never overlap. */
export function startFixedCadenceScheduler(options: SchedulerOptions): SchedulerHandle {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const origin = now();
  let nextSlot = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const schedule = (): void => {
    if (stopped) { resolveDone(); return; }
    const slot = nextSlot;
    const scheduledAtMs = origin + slot * options.cadenceMs;
    timer = setTimer(() => {
      const startedAtMs = now();
      const context = { sequence: slot + 1, scheduledAtMs, startedAtMs, lagMs: Math.max(0, startedAtMs - scheduledAtMs) };
      inFlight = options.tick(context).catch(() => undefined).finally(() => {
        if (stopped) { resolveDone(); return; }
        const elapsedSlots = Math.floor(Math.max(0, now() - origin) / options.cadenceMs);
        nextSlot = Math.max(slot + 1, elapsedSlots + 1);
        schedule();
      });
    }, Math.max(0, scheduledAtMs - now()));
  };
  schedule();
  return {
    done,
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      await inFlight;
      resolveDone();
    }
  };
}
