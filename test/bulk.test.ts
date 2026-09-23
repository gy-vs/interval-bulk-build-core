import { describe, expect, it } from 'vitest';
import {
  BulkBuildError,
  IntervalIndex,
  type BulkTempStore,
  type Interval,
} from '../src/index.js';

type IV = Interval<number>;

const iv = (id: string, start: number, end: number): IV => ({ id, start, end, value: 0 });

async function* streamOf(items: IV[]): AsyncIterable<IV> {
  for (const item of items) yield item;
}

/** Async source recording how many items were pulled and whether it was closed early. */
function tracked(items: IV[]) {
  const state = { pulls: 0, closed: false };
  const stream = (async function* (): AsyncIterable<IV> {
    try {
      for (const item of items) {
        state.pulls += 1;
        yield item;
      }
    } finally {
      state.closed = true;
    }
  })();
  return { stream, state };
}

/** Deterministic pseudo-random unique-id intervals sorted by (start, end, id). */
function sortedUnique(n: number, seed = 1): IV[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const items: IV[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(rand() * 10_000);
    const end = start + Math.floor(rand() * 200);
    items.push({ id: `id-${i}`, start, end, value: i });
  }
  return items.sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function buildByAdds(items: IV[]): IntervalIndex<number> {
  let index = new IntervalIndex<number>();
  for (const item of items) index = index.add(item);
  return index;
}

function bruteForce(items: IV[], start: number, end: number): IV[] {
  return items
    .filter((x) => x.start < end && x.end > start)
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const logBound = (n: number) => (n === 0 ? 0 : Math.ceil(Math.log2(n + 1)));

class SpyStore implements BulkTempStore<number> {
  appended = 0;
  disposed = 0;
  private buf: IV[] = [];

  get size(): number {
    return this.buf.length;
  }

  append(item: IV): void {
    this.appended += 1;
    this.buf.push(item);
  }

  async *iterator(): AsyncIterable<IV> {
    yield* this.buf;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

describe('bulkBuild', () => {
  it('builds an empty index from an empty stream (known count)', async () => {
    const index = await IntervalIndex.bulkBuild(streamOf([]), { count: 0 });
    expect(index.size()).toBe(0);
    expect(index.height()).toBe(0);
    expect(index.maxEnd()).toBe(Number.NEGATIVE_INFINITY);
    expect(index.overlap(-100, 100)).toEqual([]);
  });

  it('builds an empty index from an empty stream (counting phase)', async () => {
    const index = await IntervalIndex.bulkBuild<number>(streamOf([]));
    expect(index.size()).toBe(0);
    expect(index.height()).toBe(0);
  });

  it.each([{ counted: true }, { counted: false }])(
    'builds a single-item index (counted=$counted)',
    async ({ counted }) => {
      const item = iv('a', 1, 3);
      const index = await IntervalIndex.bulkBuild(streamOf([item]), counted ? { count: 1 } : {});
      expect(index.size()).toBe(1);
      expect(index.height()).toBe(1);
      expect(index.maxEnd()).toBe(3);
      expect(index.overlap(0, 1)).toEqual([]);
      expect(index.overlap(1, 2)).toEqual([item]);
      expect(index.overlap(3, 4)).toEqual([]);
    },
  );

  it.each([1, 2, 3, 5, 6, 7, 8, 9, 13, 15, 16, 17, 31, 33, 100])(
    'stays within the log height bound for non-full levels (n=%i)',
    async (n) => {
      const items = sortedUnique(n, n);
      const index = await IntervalIndex.bulkBuild(streamOf(items), { count: n });
      expect(index.size()).toBe(n);
      expect(index.height()).toBeLessThanOrEqual(logBound(n));
    },
  );

  it('rejects duplicate keys', async () => {
    const dup = iv('a', 1, 2);
    await expect(
      IntervalIndex.bulkBuild(streamOf([dup, dup]), { count: 2 }),
    ).rejects.toMatchObject({ code: 'unsorted' });
  });

  it('rejects duplicate ids even with distinct keys', async () => {
    const items = [iv('x', 1, 2), iv('x', 3, 4)];
    await expect(
      IntervalIndex.bulkBuild(streamOf(items), { count: 2 }),
    ).rejects.toMatchObject({ code: 'duplicate-id' });
    await expect(IntervalIndex.bulkBuild(streamOf(items))).rejects.toMatchObject({
      code: 'duplicate-id',
    });
  });

  it('rejects out-of-order input', async () => {
    await expect(
      IntervalIndex.bulkBuild(streamOf([iv('a', 5, 6), iv('b', 2, 3)]), { count: 2 }),
    ).rejects.toMatchObject({ code: 'unsorted' });
    // Equal start, descending end is also out of order.
    await expect(
      IntervalIndex.bulkBuild(streamOf([iv('a', 2, 9), iv('b', 2, 3)]), { count: 2 }),
    ).rejects.toMatchObject({ code: 'unsorted' });
  });

  it('rejects intervals with end < start', async () => {
    const err = await IntervalIndex.bulkBuild(streamOf([iv('a', 4, 1)]), { count: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BulkBuildError);
    expect((err as BulkBuildError).code).toBe('invalid-range');
  });

  it('rejects a malformed count', async () => {
    await expect(
      IntervalIndex.bulkBuild(streamOf([]), { count: -1 }),
    ).rejects.toMatchObject({ code: 'count-mismatch' });
    await expect(
      IntervalIndex.bulkBuild(streamOf([]), { count: 2.5 }),
    ).rejects.toMatchObject({ code: 'count-mismatch' });
  });

  it('rejects when the stream is shorter than count', async () => {
    const { stream, state } = tracked(sortedUnique(3));
    await expect(IntervalIndex.bulkBuild(stream, { count: 5 })).rejects.toMatchObject({
      code: 'count-mismatch',
    });
    expect(state.pulls).toBe(3);
    expect(state.closed).toBe(true);
  });

  it('rejects when the stream is longer than count and stops pulling', async () => {
    const { stream, state } = tracked(sortedUnique(6));
    await expect(IntervalIndex.bulkBuild(stream, { count: 4 })).rejects.toMatchObject({
      code: 'count-mismatch',
    });
    // count + 1 pulls detect the extra item; the rest of the stream is never read.
    expect(state.pulls).toBe(5);
    expect(state.closed).toBe(true);
  });

  it('terminates an infinite stream once count is exceeded', async () => {
    let pulls = 0;
    const infinite = (async function* (): AsyncIterable<IV> {
      for (let i = 0; ; i++) {
        pulls += 1;
        yield iv(`id-${i}`, i, i + 1);
      }
    })();
    await expect(IntervalIndex.bulkBuild(infinite, { count: 10 })).rejects.toMatchObject({
      code: 'count-mismatch',
    });
    expect(pulls).toBe(11);
  });

  it('propagates mid-stream failures and publishes nothing', async () => {
    const boom = new Error('boom');
    const items = sortedUnique(10);
    const failing = (async function* (): AsyncIterable<IV> {
      for (let i = 0; i < 4; i++) yield items[i];
      throw boom;
    })();
    await expect(IntervalIndex.bulkBuild(failing, { count: 10 })).rejects.toBe(boom);

    const failingUncounted = (async function* (): AsyncIterable<IV> {
      for (let i = 0; i < 4; i++) yield items[i];
      throw boom;
    })();
    await expect(IntervalIndex.bulkBuild(failingUncounted)).rejects.toBe(boom);
  });

  it('supports aborting mid-stream', async () => {
    const items = sortedUnique(20);
    const ac = new AbortController();
    const stream = (async function* (): AsyncIterable<IV> {
      for (let i = 0; i < items.length; i++) {
        if (i === 5) ac.abort();
        yield items[i];
      }
    })();
    await expect(
      IntervalIndex.bulkBuild(stream, { count: items.length, signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('supports aborting during the counting phase', async () => {
    const items = sortedUnique(20);
    const ac = new AbortController();
    const stream = (async function* (): AsyncIterable<IV> {
      for (let i = 0; i < items.length; i++) {
        if (i === 5) ac.abort();
        yield items[i];
      }
    })();
    await expect(IntervalIndex.bulkBuild(stream, { signal: ac.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      IntervalIndex.bulkBuild(streamOf([]), { count: 0, signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('enforces the temp store budget during the counting phase', async () => {
    const { stream, state } = tracked(sortedUnique(5));
    await expect(
      IntervalIndex.bulkBuild(stream, { maxBufferedItems: 3 }),
    ).rejects.toMatchObject({ code: 'budget-exceeded' });
    expect(state.closed).toBe(true);
  });

  it('uses and disposes a custom temp store on success', async () => {
    const store = new SpyStore();
    const items = sortedUnique(50);
    const index = await IntervalIndex.bulkBuild(streamOf(items), { tempStore: store });
    expect(store.appended).toBe(50);
    expect(store.disposed).toBe(1);
    expect(index.size()).toBe(50);
    expect(index.overlap(-1, 20_000)).toEqual(bruteForce(items, -1, 20_000));
  });

  it('disposes the temp store after a failure', async () => {
    const store = new SpyStore();
    const boom = new Error('boom');
    const failing = (async function* (): AsyncIterable<IV> {
      yield* sortedUnique(4);
      throw boom;
    })();
    await expect(IntervalIndex.bulkBuild(failing, { tempStore: store })).rejects.toBe(boom);
    expect(store.disposed).toBe(1);
  });

  it('recovers from a transient failure on retry', async () => {
    const items = sortedUnique(100);
    let attempt = 0;
    const flaky = (): AsyncIterable<IV> =>
      (async function* () {
        attempt += 1;
        for (let i = 0; i < items.length; i++) {
          if (attempt === 1 && i === 40) throw new Error('transient');
          yield items[i];
        }
      })();

    await expect(
      IntervalIndex.bulkBuild(flaky(), { count: items.length }),
    ).rejects.toThrow('transient');
    const index = await IntervalIndex.bulkBuild(flaky(), { count: items.length });
    expect(index.size()).toBe(100);
    expect(index.overlap(-1, 20_000)).toEqual(bruteForce(items, -1, 20_000));
  });

  it('leaves existing indexes untouched when a build fails', async () => {
    const good = buildByAdds(sortedUnique(50, 5));
    const before = good.overlap(-1, 20_000);
    await expect(
      IntervalIndex.bulkBuild(streamOf([iv('b', 2, 3), iv('a', 1, 2)]), { count: 2 }),
    ).rejects.toMatchObject({ code: 'unsorted' });
    expect(good.overlap(-1, 20_000)).toEqual(before);
  });

  it('matches item-by-item construction on random data', async () => {
    const items = sortedUnique(3000, 42);
    const viaCount = await IntervalIndex.bulkBuild(streamOf(items), { count: items.length });
    const viaCounting = await IntervalIndex.bulkBuild(streamOf(items));
    const viaAdds = buildByAdds(items);

    // Deterministic shape: identical height whether the count was known or measured.
    expect(viaCount.height()).toBeLessThanOrEqual(logBound(items.length));
    expect(viaCounting.height()).toBe(viaCount.height());
    // AVL bound for item-by-item insertion.
    expect(viaAdds.height()).toBeLessThanOrEqual(Math.ceil(1.45 * Math.log2(items.length + 2)));

    let s = 7;
    const rand = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let q = 0; q < 500; q++) {
      const start = Math.floor(rand() * 10_200) - 100;
      const end = start + Math.floor(rand() * 400);
      const expected = bruteForce(items, start, end);
      expect(viaCount.overlap(start, end)).toEqual(expected);
      expect(viaCounting.overlap(start, end)).toEqual(expected);
      expect(viaAdds.overlap(start, end)).toEqual(expected);
    }
    expect(viaCount.maxEnd()).toBe(Math.max(...items.map((x) => x.end)));
  });

  it('builds from a large stream in one pass with backpressure', async () => {
    const n = 100_000;
    const items = sortedUnique(n, 99);
    const { stream, state } = tracked(items);
    const index = await IntervalIndex.bulkBuild(stream, { count: n });
    expect(index.size()).toBe(n);
    // Exactly one pull per item plus one confirming pull; no read-ahead.
    expect(state.pulls).toBe(n);
    expect(state.closed).toBe(true);
    expect(index.height()).toBeLessThanOrEqual(logBound(n));
    for (let q = 0; q < 50; q++) {
      const start = q * 197;
      expect(index.overlap(start, start + 250)).toEqual(bruteForce(items, start, start + 250));
    }
  }, 20_000);
});

describe('index basics', () => {
  it('is persistent: operations never mutate the receiver', () => {
    const empty = new IntervalIndex<number>();
    const one = empty.add(iv('a', 1, 3));
    const two = one.add(iv('b', 2, 4));
    expect(empty.size()).toBe(0);
    expect(one.size()).toBe(1);
    expect(two.size()).toBe(2);
    expect(one.overlap(1, 2)).toHaveLength(1);

    const removed = two.remove('a');
    expect(removed.size()).toBe(1);
    expect(two.size()).toBe(2);
    expect(removed.overlap(0, 10).map((x) => x.id)).toEqual(['b']);
  });

  it('rejects invalid ranges and duplicate keys on add', () => {
    const index = new IntervalIndex<number>();
    expect(() => index.add(iv('a', 3, 1))).toThrow('range');
    const one = index.add(iv('a', 1, 2));
    expect(() => one.add(iv('a', 1, 2))).toThrow('duplicate');
  });

  it('removes every interval with a matching id', () => {
    const index = buildByAdds([iv('x', 1, 2), iv('x', 5, 6), iv('y', 3, 4)]);
    const removed = index.remove('x');
    expect(removed.size()).toBe(1);
    expect(removed.overlap(0, 10).map((x) => x.id)).toEqual(['y']);
    expect(index.remove('missing')).toBe(index);
  });

  it('returns overlap results ordered by (start, end, id)', () => {
    const index = buildByAdds([iv('b', 1, 9), iv('a', 1, 2), iv('c', 0, 5), iv('d', 1, 2)]);
    expect(index.overlap(1, 2).map((x) => x.id)).toEqual(['c', 'a', 'd', 'b']);
  });
});
