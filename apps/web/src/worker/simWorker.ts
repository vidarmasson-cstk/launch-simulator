/// <reference lib="webworker" />
import { runSimulation, type Scenario } from '@launch-sim/engine';

export type WorkerRequest = { type: 'run'; scenario: Scenario };
export type WorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'result'; result: ReturnType<typeof runSimulation>; ms: number }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  if (ev.data.type !== 'run') return;
  const t0 = performance.now();
  let lastPost = 0;
  try {
    const result = runSimulation(ev.data.scenario, {
      onProgress: (fraction) => {
        const now = performance.now();
        if (now - lastPost < 100 && fraction < 1) return; // ~10/s
        lastPost = now;
        ctx.postMessage({ type: 'progress', fraction } satisfies WorkerResponse);
      },
    });
    ctx.postMessage({ type: 'result', result, ms: performance.now() - t0 } satisfies WorkerResponse);
  } catch (e) {
    ctx.postMessage({
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    } satisfies WorkerResponse);
  }
};
