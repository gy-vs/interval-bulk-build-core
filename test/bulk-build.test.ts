import { describe, expect, it } from 'vitest';
import {
  BulkBuildError,
  IntervalIndex,
  type BulkBuildOptions,
  type Interval,
  type IntervalNode,
  type TempStore,
} from '../src/index.js';

const iv = (id: string, start: number, end: number, value = 0): Interval<number> => ({
  id,
  start,
  end,
  value,
});

const sortedItems = (n: number): Interval<number>[] =>
  Array.from({ length: n }, (_, i) => iv(`id-${i}`, i, i + 1, i));

async function* streamOf<V>(items: Interval<V>[]): AsyncGenerator<Interval<V>> {
  for (const item of items) yield item;
}

/** Reference implementation: the original scan-and-sort semantics. */
function refOverlap<V>(items: Interval<V>[], start: number, end: number): Interval<V>[] {
  return items
    .filter((x) => x.start < end && x.end > start)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Throws unless height/size/maxEnd of every node are consistent. */
function assertNode<V>(node: IntervalNode<V> | null): { height: number; size: number; maxEnd: number } {
  if (node === null) return { height: 0, size: 0, maxEnd: -Infinity };
  const l = assertNode(node.left);
  const r = assertNode(node.right);
  const height = 1 + Math.max(l.height, r.height);
  const size = 1 + l.size + r.size;
  const maxEnd = Math.max(node.item.end, l.maxEnd, r.maxEnd);
  if (node.height !== height || node.size !== size || node.maxEnd !== maxEnd) {
    throw new Error(
      `inconsistent node ${node.item.id}: have h=${node.height} size=${node.size} maxEnd=${node.maxEnd}, ` +
        `want h=${height} size=${size} maxEnd=${maxEnd}`,
    );
  }
  return { height, size, maxEnd };
}

function trackingStore<V>() {
  const state = { disposed: false, pushed: 0 };
  const items: Interval<V>[] = [];
  const store: TempStore<V> = {
    get length() {
      return items.length;
    },
    push(item) {
      state.pushed++;
      items.push(item);
    },
    get: (i) => items[i],
    dispose() {
      state.disposed = true;
      items.length = 0;
    },
  };
  return { store, state };
}

describe('bulkBuild: basic shapes', () => {
  it('builds an empty index from an empty stream (count known)', async () => {
    const idx = await IntervalIndex.bulkBuild(streamOf<number>([]), { count: 0 });
    expect(idx.size()).toBe(0);
    expect(idx.height()).toBe(0);
    expect(idx.rootNode()).toBeNull();
    expect(idx.overlap(-10, 10)).toEqual([]);
  });

  it('builds an empty index from an empty stream (counting pass)', async () => {
    const idx = await IntervalIndex.bulkBuild(streamOf<number>([]));
    expect(idx.size()).toBe(0);
    expect(idx.toArray()).toEqual([]);
  });

  it('builds a single-item tree', async () => {
    const optsList: BulkBuildOptions<number>[] = [{ count: 1 }, {}];
    for (const opts of optsList) {
      const idx = await IntervalIndex.bulkBuild(streamOf([iv('a', 2, 5, 7)]), opts);
      expect(idx.size()).toBe(1);
      expect(idx.height()).toBe(1);
      const root = idx.rootNode();
      expect(root?.item).toEqual(iv('a', 2, 5, 7));
      expect(root?.maxEnd).toBe(5);
      expect(idx.overlap(0, 2)).toEqual([]);
      expect(idx.overlap(2, 3)).toEqual([iv('a', 2, 5, 7)]);
      expect(idx.overlap(5, 9)).toEqual([]);
    }
  });

  it('accepts plain synchronous iterables', async () => {
    const idx = await IntervalIndex.bulkBuild(sortedItems(3), { count: 3 });
    expect(idx.size()).toBe(3);
    expect(idx.toArray()).toEqual(sortedItems(3));
  });

  it('builds complete trees for non-full levels', async () => {
    const shapes: Array<[number, number, number]> = [
      // n, left subtree size, right subtree size
      [2, 1, 0],
      [4, 2, 1],
      [5, 3, 1],
      [6, 3, 2],
      [12, 7, 4],
    ];
    for (const [n, left, right] of shapes) {
      const items = sortedItems(n);
      const idx = await IntervalIndex.bulkBuild(streamOf(items), { count: n });
      const root = idx.rootNode();
      expect(root?.size).toBe(n);
      expect(root?.left?.size ?? 0).toBe(left);
      expect(root?.right?.size ?? 0).toBe(right);
      expect(idx.height()).toBe(Math.ceil(Math.log2(n + 1)));
      expect(idx.toArray()).toEqual(items);
      expect(() => assertNode(root)).not.toThrow();
    }
  });

  it('keeps bulk-built height at ceil(log2(n+1)) across sizes', async () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 31, 32, 100, 1000]) {
      const items = sortedItems(n);
      const counted = await IntervalIndex.bulkBuild(streamOf(items), { count: n });
      const buffered = await IntervalIndex.bulkBuild(streamOf(items));
      const expected = n === 0 ? 0 : Math.ceil(Math.log2(n + 1));
      expect(counted.height()).toBe(expected);
      expect(buffered.height()).toBe(expected);
      expect(buffered.toArray()).toEqual(items);
    }
  });
});

describe('bulkBuild: input validation', () => {
  it('rejects duplicate ids', async () => {
    const items = [iv('a', 1, 2), iv('a', 3, 4)];
    await expect(IntervalIndex.bulkBuild(streamOf(items), { count: 2 })).rejects.toMatchObject({
      name: 'BulkBuildError',
      code: 'duplicate-id',
    });
    await expect(IntervalIndex.bulkBuild(streamOf(items))).rejects.toBeInstanceOf(BulkBuildError);
    await expect(IntervalIndex.bulkBuild(streamOf(items))).rejects.toMatchObject({
      code: 'duplicate-id',
    });
  });

  it('rejects duplicated keys (start, end, id)', async () => {
    const items = [iv('a', 1, 2), iv('a', 1, 2)];
    await expect(IntervalIndex.bulkBuild(streamOf(items), { count: 2 })).rejects.toMatchObject({
      code: 'unordered',
    });
    await expect(IntervalIndex.bulkBuild(streamOf(items))).rejects.toMatchObject({
      code: 'unordered',
    });
  });

  it('rejects out-of-order streams', async () => {
    const cases = [
      [iv('a', 5, 6), iv('b', 3, 4)], // start decreases
      [iv('a', 1, 5), iv('b', 1, 4)], // equal start, end decreases
      [iv('b', 1, 4), iv('a', 1, 4)], // equal start/end, id decreases
    ];
    for (const items of cases) {
      await expect(IntervalIndex.bulkBuild(streamOf(items), { count: 2 })).rejects.toMatchObject({
        code: 'unordered',
      });
      await expect(IntervalIndex.bulkBuild(streamOf(items))).rejects.toMatchObject({
        code: 'unordered',
      });
    }
  });

  it('rejects intervals with end < start', async () => {
    await expect(
      IntervalIndex.bulkBuild(streamOf([iv('a', 3, 1)]), { count: 1 }),
    ).rejects.toMatchObject({ code: 'invalid-interval' });
    await expect(IntervalIndex.bulkBuild(streamOf([iv('a', 3, 1)]))).rejects.toMatchObject({
      code: 'invalid-interval',
    });
  });

  it('rejects invalid count values', async () => {
    await expect(IntervalIndex.bulkBuild(streamOf([]), { count: -1 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(IntervalIndex.bulkBuild(streamOf([]), { count: 1.5 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('bulkBuild: count mismatches', () => {
  it('rejects when the stream yields fewer items than count', async () => {
    await expect(
      IntervalIndex.bulkBuild(streamOf(sortedItems(2)), { count: 3 }),
    ).rejects.toMatchObject({ code: 'count-mismatch' });
  });

  it('rejects when the stream yields more items than count', async () => {
    await expect(
      IntervalIndex.bulkBuild(streamOf(sortedItems(3)), { count: 2 }),
    ).rejects.toMatchObject({ code: 'count-mismatch' });
  });

  it('rejects a non-empty stream with count 0', async () => {
    await expect(
      IntervalIndex.bulkBuild(streamOf(sortedItems(1)), { count: 0 }),
    ).rejects.toMatchObject({ code: 'count-mismatch' });
  });

  it('releases the source after a mismatch', async () => {
    let cleaned = false;
    async function* gen() {
      try {
        for (const item of sortedItems(10)) yield item;
      } finally {
        cleaned = true;
      }
    }
    await expect(IntervalIndex.bulkBuild(gen(), { count: 5 })).rejects.toMatchObject({
      code: 'count-mismatch',
    });
    expect(cleaned).toBe(true);
  });
});

describe('bulkBuild: failures publish no partial root', () => {
  const boom = new Error('boom');

  async function* failing<V>(items: Interval<V>[], failAt: number): AsyncGenerator<Interval<V>> {
    for (let i = 0; i < items.length; i++) {
      if (i === failAt) throw boom;
      yield items[i];
    }
  }

  it('propagates mid-stream failures (known count)', async () => {
    await expect(
      IntervalIndex.bulkBuild(failing(sortedItems(10), 4), { count: 10 }),
    ).rejects.toBe(boom);
  });

  it('propagates mid-stream failures and disposes temp storage (counting pass)', async () => {
    const { store, state } = trackingStore<number>();
    await expect(
      IntervalIndex.bulkBuild(failing(sortedItems(10), 4), { tempStore: () => store }),
    ).rejects.toBe(boom);
    expect(state.pushed).toBe(4);
    expect(state.disposed).toBe(true);
  });

  it('a transient failure does not affect a retry', async () => {
    const items = sortedItems(10);
    await expect(IntervalIndex.bulkBuild(failing(items, 3), { count: 10 })).rejects.toBe(boom);
    const idx = await IntervalIndex.bulkBuild(streamOf(items), { count: 10 });
    expect(idx.toArray()).toEqual(items);
  });

  it('honours a pre-aborted signal without pulling', async () => {
    let pulls = 0;
    async function* gen() {
      for (const item of sortedItems(5)) {
        pulls++;
        yield item;
      }
    }
    const ac = new AbortController();
    ac.abort(new Error('nope'));
    await expect(
      IntervalIndex.bulkBuild(gen(), { count: 5, signal: ac.signal }),
    ).rejects.toThrow('nope');
    expect(pulls).toBe(0);
  });

  it('cancels a counted build mid-stream', async () => {
    const ac = new AbortController();
    let produced = 0;
    async function* gen() {
      for (const item of sortedItems(1000)) {
        produced++;
        if (produced === 3) ac.abort(new Error('stop'));
        yield item;
      }
    }
    await expect(
      IntervalIndex.bulkBuild(gen(), { count: 1000, signal: ac.signal }),
    ).rejects.toThrow('stop');
    expect(produced).toBeLessThanOrEqual(4);
  });

  it('cancels a counting-pass build mid-stream and disposes temp storage', async () => {
    const ac = new AbortController();
    const { store, state } = trackingStore<number>();
    let produced = 0;
    async function* gen() {
      for (const item of sortedItems(1000)) {
        produced++;
        if (produced === 3) ac.abort(new Error('stop'));
        yield item;
      }
    }
    await expect(
      IntervalIndex.bulkBuild(gen(), { signal: ac.signal, tempStore: () => store }),
    ).rejects.toThrow('stop');
    expect(produced).toBeLessThanOrEqual(4);
    expect(state.disposed).toBe(true);
  });

  it('enforces the temporary storage budget', async () => {
    await expect(
      IntervalIndex.bulkBuild(streamOf(sortedItems(5)), { tempBudget: 3 }),
    ).rejects.toMatchObject({ code: 'budget-exceeded' });
    const ok = await IntervalIndex.bulkBuild(streamOf(sortedItems(3)), { tempBudget: 3 });
    expect(ok.size()).toBe(3);
  });

  it('disposes a custom temp store when the budget is exceeded', async () => {
    const { store, state } = trackingStore<number>();
    await expect(
      IntervalIndex.bulkBuild(streamOf(sortedItems(5)), { tempBudget: 2, tempStore: () => store }),
    ).rejects.toMatchObject({ code: 'budget-exceeded' });
    expect(state.disposed).toBe(true);
  });

  it('disposes temp storage after a successful build', async () => {
    const { store, state } = trackingStore<number>();
    const idx = await IntervalIndex.bulkBuild(streamOf(sortedItems(4)), { tempStore: () => store });
    expect(idx.size()).toBe(4);
    expect(state.disposed).toBe(true);
  });
});

describe('bulkBuild: backpressure and large inputs', () => {
  it('pulls exactly count + 1 times when the count is known', async () => {
    let nextCalls = 0;
    const items = sortedItems(10);
    const source: AsyncIterable<Interval<number>> = {
      [Symbol.asyncIterator](): AsyncIterator<Interval<number>> {
        let i = 0;
        return {
          async next(): Promise<IteratorResult<Interval<number>>> {
            nextCalls++;
            if (i < items.length) return { value: items[i++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
    const idx = await IntervalIndex.bulkBuild(source, { count: 10 });
    expect(idx.size()).toBe(10);
    expect(nextCalls).toBe(11);
  });

  it('stops pulling once a counted build fails', async () => {
    let produced = 0;
    async function* gen() {
      for (let i = 0; i < 1_000_000; i++) {
        produced++;
        yield iv(`id-${i}`, i, i + 1);
      }
    }
    await expect(IntervalIndex.bulkBuild(gen(), { count: 5 })).rejects.toMatchObject({
      code: 'count-mismatch',
    });
    expect(produced).toBe(6);
  });

  it('builds 100k items in linear time with logarithmic height', async () => {
    const n = 100_000;
    const items = sortedItems(n);
    let produced = 0;
    async function* gen() {
      for (const item of items) {
        produced++;
        yield item;
      }
    }
    const idx = await IntervalIndex.bulkBuild(gen(), { count: n });
    expect(idx.size()).toBe(n);
    expect(produced).toBe(n);
    expect(idx.height()).toBe(Math.ceil(Math.log2(n + 1)));
    expect(() => assertNode(idx.rootNode())).not.toThrow();
    const queries: Array<[number, number]> = [
      [0, 1],
      [49_990, 50_010],
      [99_999, 100_001],
      [200_000, 300_000],
    ];
    for (const [s, e] of queries) {
      expect(idx.overlap(s, e)).toEqual(refOverlap(items, s, e));
    }
  });

  it('builds 100k items through the counting pass under a budget', async () => {
    const n = 100_000;
    const items = sortedItems(n);
    const idx = await IntervalIndex.bulkBuild(streamOf(items), { tempBudget: n });
    expect(idx.size()).toBe(n);
    expect(idx.height()).toBe(Math.ceil(Math.log2(n + 1)));
    expect(idx.overlap(10, 20)).toEqual(refOverlap(items, 10, 20));
  });
});

describe('bulkBuild: equivalence with item-by-item builds', () => {
  const rand = mulberry32(42);
  const n = 5000;
  const items: Interval<number>[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(rand() * 1000);
    const end = start + Math.floor(rand() * 50);
    items.push(iv(`id-${i}`, start, end, i));
  }
  const sorted = [...items].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  );

  it('matches repeated add() and the reference scan on random queries', async () => {
    // Item-by-item (AVL) build from shuffled input.
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let avl = new IntervalIndex<number>();
    for (const item of shuffled) avl = avl.add(item);

    const counted = await IntervalIndex.bulkBuild(streamOf(sorted), { count: n });
    const buffered = await IntervalIndex.bulkBuild(streamOf(sorted));

    expect(counted.size()).toBe(n);
    expect(counted.toArray()).toEqual(sorted);
    expect(buffered.toArray()).toEqual(sorted);
    expect(avl.toArray()).toEqual(sorted);
    // AVL height stays within its 1.44*log2(n) bound; bulk height is exact.
    expect(avl.height()).toBeLessThanOrEqual(Math.ceil(1.4405 * Math.log2(n + 2)));
    expect(counted.height()).toBe(Math.ceil(Math.log2(n + 1)));
    expect(() => assertNode(counted.rootNode())).not.toThrow();
    expect(() => assertNode(avl.rootNode())).not.toThrow();

    for (let q = 0; q < 500; q++) {
      const s = Math.floor(rand() * 1200) - 100;
      const e = q % 17 === 0 ? s - Math.floor(rand() * 10) : s + Math.floor(rand() * 200);
      const expected = refOverlap(sorted, s, e);
      expect(counted.overlap(s, e)).toEqual(expected);
      expect(buffered.overlap(s, e)).toEqual(expected);
      expect(avl.overlap(s, e)).toEqual(expected);
    }
  });
});

describe('index persistence', () => {
  it('add/remove return new indexes and leave the old one untouched', async () => {
    const base = await IntervalIndex.bulkBuild(streamOf(sortedItems(10)), { count: 10 });
    const added = base.add(iv('x', 100, 110));
    expect(base.size()).toBe(10);
    expect(added.size()).toBe(11);
    expect(base.overlap(99, 111)).toEqual([]);
    expect(added.overlap(99, 111)).toEqual([iv('x', 100, 110)]);

    const removed = added.remove('id-3');
    expect(removed.size()).toBe(10);
    expect(removed.toArray().some((x) => x.id === 'id-3')).toBe(false);
    expect(added.size()).toBe(11);

    const noop = added.remove('missing');
    expect(noop.size()).toBe(11);
  });

  it('keeps maxEnd consistent on every node after inserts', () => {
    let idx = new IntervalIndex<number>();
    const rand = mulberry32(7);
    const seen: Interval<number>[] = [];
    for (let i = 0; i < 2000; i++) {
      const start = Math.floor(rand() * 500);
      const item = iv(`id-${i}`, start, start + Math.floor(rand() * 30));
      seen.push(item);
      idx = idx.add(item);
    }
    expect(() => assertNode(idx.rootNode())).not.toThrow();
    expect(idx.overlap(100, 200)).toEqual(refOverlap(seen, 100, 200));
  });
});
