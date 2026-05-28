export type TrialEvent =
  | {
      type: "run:start";
      runId: string;
      benchmarkId: string;
      modelId: string;
      policy: string;
      description: string;
      tasks: Array<{ taskId: string; hint: string }>;
      hints: string;
      hintsHash: string;
      ts: number;
    }
  | {
      type: "trial:start";
      taskId: string;
      trialId: string;
      instruction: string;
      ts: number;
    }
  | {
      type: "bootstrap";
      taskId: string;
      tool: string;
      input: unknown;
      output: string;
      outputBytes: number;
      ok: boolean;
      errorMessage?: string;
      ts: number;
    }
  | {
      type: "step";
      taskId: string;
      step: number;
      tool: string;
      planFirst: string;
      input: unknown;
      output: string;
      outputBytes: number;
      latencyMs: number;
      ok: boolean;
      errorMessage?: string;
      ts: number;
    }
  | {
      type: "trial:end";
      taskId: string;
      scoreAvailable: boolean;
      score?: number;
      scoreDetail: string[];
      ts: number;
    }
  | {
      type: "judge";
      taskId: string;
      attempt: number;
      ok: boolean;
      reason?: string;
      proposedOutcome?: string;
      latencyMs: number;
      ts: number;
    }
  | {
      type: "run:end";
      finalPct?: number;
      ts: number;
    };

type Listener = (e: TrialEvent) => void;

class Bus {
  private listeners = new Set<Listener>();
  private buffer: TrialEvent[] = [];
  private bufferLimit = 1000;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: TrialEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    }
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("event listener error:", err);
      }
    }
  }

  replay(): TrialEvent[] {
    return [...this.buffer];
  }
}

export const bus = new Bus();
