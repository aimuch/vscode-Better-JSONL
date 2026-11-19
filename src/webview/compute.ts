// Off-main-thread compute utilities:
// 1. Cancelable time-sliced async runner so heavy scans keep UI at 60fps.
// 2. Zero-dependency inline Blob Web Worker runner (when Worker + Blob are available in browser).

export interface SliceOptions {
  /** Target time budget per frame slice in ms (default 10ms). */
  budgetMs?: number;
  /** Optional AbortSignal to cancel in-flight work. */
  signal?: AbortSignal;
  /** Optional progress callback receiving (processed, total). */
  onProgress?: (done: number, total: number) => void;
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/**
 * Iterates indices [0, total) in non-blocking time slices, invoking `step(i)`.
 * Returns `true` if completed, `false` if aborted via `signal`.
 */
export async function runSliced(
  total: number,
  step: (i: number) => boolean | void,
  opts: SliceOptions = {},
): Promise<boolean> {
  const budget = opts.budgetMs ?? 10;
  const sig = opts.signal;
  const onProgress = opts.onProgress;
  let i = 0;
  while (i < total) {
    if (sig?.aborted) return false;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    while (i < total) {
      if (step(i) === false) return true;
      i++;
      if ((i & 63) === 0) {
        if (sig?.aborted) return false;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - t0 >= budget) break;
      }
    }
    onProgress?.(i, total);
    if (i < total) await nextFrame();
  }
  return !sig?.aborted;
}

/**
 * Runs a pure self-contained JS function inside an inline Blob Web Worker when supported,
 * falling back transparently to a microtask in Node or restricted environments.
 */
export function runInInlineWorker<In, Out>(
  fn: (input: In) => Out,
  input: In,
  signal?: AbortSignal,
): Promise<Out> {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      setTimeout(() => {
        if (signal?.aborted) return reject(new Error('Aborted'));
        try {
          resolve(fn(input));
        } catch (e) {
          reject(e);
        }
      }, 0);
    });
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const code = `self.onmessage = function(e) {
      try {
        var fn = (${fn.toString()});
        self.postMessage({ ok: true, value: fn(e.data) });
      } catch (err) {
        self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    };`;
    let url = '';
    let worker: Worker | null = null;
    const cleanup = () => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      if (url) {
        URL.revokeObjectURL(url);
        url = '';
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const blob = new Blob([code], { type: 'application/javascript' });
      url = URL.createObjectURL(blob);
      worker = new Worker(url);
      worker.onmessage = (ev) => {
        const msg = ev.data as { ok: boolean; value?: Out; error?: string };
        cleanup();
        if (msg.ok) resolve(msg.value as Out);
        else reject(new Error(msg.error ?? 'Worker error'));
      };
      worker.onerror = (ev) => {
        cleanup();
        // Fallback to main thread if CSP blocks blob worker in a legacy host
        try {
          resolve(fn(input));
        } catch (err) {
          reject(err ?? new Error(ev.message));
        }
      };
      worker.postMessage(input);
    } catch {
      cleanup();
      try {
        resolve(fn(input));
      } catch (err) {
        reject(err);
      }
    }
  });
}
