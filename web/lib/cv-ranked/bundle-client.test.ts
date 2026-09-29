import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { download, type Meter, meters } from './bundle-client.js';
import { CvError, LIMITS } from './document-checks.js';

beforeEach(() => {
  vi.useFakeTimers();
  // The watchdog and the meters read performance.now; tie it to the fake clock.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A body that delivers `chunks`, each after `gapMs` of silence. */
function body(chunks: Uint8Array[], gapMs: number): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream({
    async pull(controller) {
      await wait(gapMs);
      const chunk = chunks[next++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

/** fetch that answers with `respond()`, or rejects the way fetch does when its signal aborts. */
function stubFetch(respond: () => Promise<Response> | Response) {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Promise<Response>((resolve, reject) => {
      const aborted = () => reject(new DOMException('aborted', 'AbortError'));
      if (init.signal?.aborted) return aborted();
      init.signal?.addEventListener('abort', aborted);
      Promise.resolve(respond()).then(resolve, reject);
    });
  });
  return calls;
}

function recorder(): Meter & { total: number } {
  const meter = {
    total: 0,
    expect() {},
    add(bytes: number) {
      meter.total += bytes;
    },
    settle() {},
  };
  return meter;
}

const bytes = (length: number, fill = 1) => new Uint8Array(length).fill(fill);

describe('download', () => {
  it('never cuts off a slow download that keeps delivering', async () => {
    // Six chunks 20 s apart: two minutes in all, never 30 s of silence.
    const chunks = [1, 2, 3, 4, 5, 6].map((fill) => bytes(4, fill));
    stubFetch(() => new Response(body(chunks, 20_000)));
    const meter = recorder();
    const result = download('/file', { expected: 24, meter });
    await vi.advanceTimersByTimeAsync(7 * 20_000);
    const received = await result;
    expect(received?.byteLength).toBe(24);
    expect(Array.from(received ?? []).slice(0, 5)).toEqual([1, 1, 1, 1, 2]);
    expect(meter.total).toBe(24);
  });

  it('abandons a body that stops delivering, as a network failure', async () => {
    stubFetch(() => new Response(body([bytes(4)], LIMITS.downloadStallMs * 10)));
    const result = download('/file', { expected: 4 });
    const settled = expect(result).rejects.toEqual(new CvError('network'));
    await vi.advanceTimersByTimeAsync(LIMITS.downloadStallMs + 1_000);
    await settled;
  });

  it('counts waiting for the headers as silence too', async () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    const result = download('/file');
    const settled = expect(result).rejects.toEqual(new CvError('network'));
    await vi.advanceTimersByTimeAsync(LIMITS.downloadStallMs + 1_000);
    await settled;
  });

  it('returns null for a non-OK status', async () => {
    stubFetch(() => new Response('gone', { status: 404 }));
    await expect(download('/file')).resolves.toBeNull();
  });

  it('stops reading once the body passes its expected size', async () => {
    const pulled = vi.fn();
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled();
        controller.enqueue(bytes(4));
      },
    });
    stubFetch(() => new Response(endless));
    const received = await download('/file', { expected: 6 });
    expect(received?.byteLength).toBe(8);
    expect(pulled.mock.calls.length).toBeLessThan(5);
  });

  it('gives up when the caller aborts', async () => {
    stubFetch(() => new Response(body([bytes(4)], 10_000)));
    const group = new AbortController();
    const result = download('/file', { expected: 4, signal: group.signal });
    const settled = expect(result).rejects.toEqual(new CvError('network'));
    await vi.advanceTimersByTimeAsync(1_000);
    group.abort();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  });

  it('sends no credentials or referrer', async () => {
    const calls = stubFetch(() => new Response(bytes(1)));
    await download('/file');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  });
});

describe('meters', () => {
  it('reports nothing until both sizes are known', () => {
    const report = vi.fn();
    const { bundle, model } = meters(report);
    model.expect(100);
    model.add(10);
    expect(report).not.toHaveBeenCalled();
    bundle.expect(50);
    expect(report).toHaveBeenLastCalledWith(10, 150);
  });

  it('throttles chunk reports but always reports completion', () => {
    const report = vi.fn();
    const { bundle, model } = meters(report);
    bundle.expect(10);
    model.expect(10);
    report.mockClear();
    bundle.add(2);
    bundle.add(2);
    expect(report).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(300);
    bundle.add(2);
    expect(report).toHaveBeenLastCalledWith(6, 20);
    bundle.add(4);
    model.add(10);
    expect(report).toHaveBeenLastCalledWith(20, 20);
  });

  it('drops what a failed download will never deliver', () => {
    const report = vi.fn();
    const { bundle, model } = meters(report);
    bundle.expect(10);
    model.expect(100);
    model.add(30);
    model.settle();
    expect(report).toHaveBeenLastCalledWith(30, 40);
    model.add(50);
    bundle.add(10);
    expect(report).toHaveBeenLastCalledWith(40, 40);
  });
});
