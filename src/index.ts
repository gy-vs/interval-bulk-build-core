/**
 * Persistent interval index.
 *
 * Intervals are stored in an immutable balanced binary tree ordered by
 * `(start, end, id)` and augmented with a per-node `maxEnd`, so overlap
 * queries cost O(log n + k). Mutations copy the path and return a new
 * index; previously obtained indexes keep working unchanged.
 */

export type Interval<V> = { id: string; start: number; end: number; value: V };

/** Read-only view of a tree node, exposed for inspection. Do not mutate. */
export interface IntervalNode<V> {
  readonly item: Interval<V>;
  readonly left: IntervalNode<V> | null;
  readonly right: IntervalNode<V> | null;
  readonly height: number;
  readonly size: number;
  readonly maxEnd: number;
}

/** Machine-readable failure causes of {@link IntervalIndex.bulkBuild}. */
export type BulkBuildErrorCode =
  | 'invalid-interval'
  | 'unordered'
  | 'duplicate-id'
  | 'count-mismatch'
  | 'budget-exceeded';

export class BulkBuildError extends Error {
  constructor(readonly code: BulkBuildErrorCode, message: string) {
    super(message);
    this.name = 'BulkBuildError';
  }
}

/**
 * Temporary storage for the counting pass of a bulk build without a known
 * count. Implementations must be synchronous; `dispose` is always called
 * once the build settles, in particular after failures.
 */
export interface TempStore<V> {
  readonly length: number;
  push(item: Interval<V>): void;
  get(index: number): Interval<V>;
  dispose(): void;
}

export interface BulkBuildOptions<V> {
  /**
   * Expected item count. When given, the tree shape is fixed up front and
   * items are placed as they arrive — O(log n) working space and no
   * temporary storage. A stream yielding fewer or more items fails with a
   * `count-mismatch` error.
   */
  count?: number;
  /**
   * Cancellation signal, checked between items. An aborted build rejects
   * and never publishes a partial root.
   */
  signal?: AbortSignal;
  /**
   * Maximum number of items held in temporary storage during the counting
   * pass. Only used when `count` is not provided; unbounded by default.
   */
  tempBudget?: number;
  /**
   * Custom temporary storage for the counting pass (mainly for tests).
   * Ignored when `count` is provided.
   */
  tempStore?: () => TempStore<V>;
}

function compareItems<V>(a: Interval<V>, b: Interval<V>): number {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  if (a.end !== b.end) return a.end < b.end ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function assertRange<V>(item: Interval<V>): void {
  if (!(item.end >= item.start)) throw new Error('range');
}

function heightOf<V>(node: IntervalNode<V> | null): number {
  return node === null ? 0 : node.height;
}

function makeNode<V>(
  item: Interval<V>,
  left: IntervalNode<V> | null,
  right: IntervalNode<V> | null,
): IntervalNode<V> {
  return {
    item,
    left,
    right,
    height: 1 + Math.max(heightOf(left), heightOf(right)),
    size: 1 + (left === null ? 0 : left.size) + (right === null ? 0 : right.size),
    maxEnd: Math.max(
      item.end,
      left === null ? -Infinity : left.maxEnd,
      right === null ? -Infinity : right.maxEnd,
    ),
  };
}

/* AVL rotations; they allocate new nodes instead of mutating. */

function rotateLeft<V>(node: IntervalNode<V>): IntervalNode<V> {
  const right = node.right!;
  return makeNode(right.item, makeNode(node.item, node.left, right.left), right.right);
}

function rotateRight<V>(node: IntervalNode<V>): IntervalNode<V> {
  const left = node.left!;
  return makeNode(left.item, left.left, makeNode(node.item, left.right, node.right));
}

function rebalance<V>(node: IntervalNode<V>): IntervalNode<V> {
  const balance = heightOf(node.left) - heightOf(node.right);
  if (balance > 1) {
    const left = node.left!;
    const fixed = heightOf(left.left) >= heightOf(left.right) ? left : rotateLeft(left);
    return rotateRight(makeNode(node.item, fixed, node.right));
  }
  if (balance < -1) {
    const right = node.right!;
    const fixed = heightOf(right.right) >= heightOf(right.left) ? right : rotateRight(right);
    return rotateLeft(makeNode(node.item, node.left, fixed));
  }
  return node;
}

function insertNode<V>(node: IntervalNode<V> | null, item: Interval<V>): IntervalNode<V> {
  if (node === null) return makeNode(item, null, null);
  const c = compareItems(item, node.item);
  if (c === 0) return makeNode(item, node.left, node.right); // same key: replace the payload
  const next =
    c < 0
      ? makeNode(node.item, insertNode(node.left, item), node.right)
      : makeNode(node.item, node.left, insertNode(node.right, item));
  return rebalance(next);
}

function queryOverlap<V>(
  node: IntervalNode<V> | null,
  start: number,
  end: number,
  out: Interval<V>[],
): void {
  if (node === null) return;
  if (node.left !== null && node.left.maxEnd > start) queryOverlap(node.left, start, end, out);
  if (node.item.start < end && node.item.end > start) out.push(node.item);
  // Everything in the right subtree starts at or after node.item.start.
  if (node.right !== null && node.item.start < end && node.right.maxEnd > start) {
    queryOverlap(node.right, start, end, out);
  }
}

function collect<V>(node: IntervalNode<V> | null, out: Interval<V>[]): void {
  if (node === null) return;
  collect(node.left, out);
  out.push(node.item);
  collect(node.right, out);
}

/**
 * Size of the left subtree of a complete binary tree holding `n` nodes
 * (last level filled left to right). Fixes the bulk-built shape
 * deterministically for a given count; the resulting height is
 * ceil(log2(n + 1)).
 */
function leftSize(n: number): number {
  if (n < 2) return 0;
  const h = Math.ceil(Math.log2(n + 1));
  const aboveLast = 2 ** (h - 1) - 1;
  const onLast = n - aboveLast;
  return 2 ** (h - 2) - 1 + Math.min(onLast, 2 ** (h - 2));
}

/** Builds the deterministic complete-tree shape from `n` sorted items. */
function buildBalanced<V>(
  get: (index: number) => Interval<V>,
  start: number,
  n: number,
): IntervalNode<V> | null {
  if (n === 0) return null;
  const leftN = leftSize(n);
  const left = buildBalanced(get, start, leftN);
  const item = get(start + leftN);
  const right = buildBalanced(get, start + leftN + 1, n - leftN - 1);
  return makeNode(item, left, right);
}

/** Same shape as {@link buildBalanced}, but pulls items from a stream. */
async function buildStreamNode<V>(
  pull: () => Promise<Interval<V> | null>,
  n: number,
): Promise<IntervalNode<V> | null> {
  if (n === 0) return null;
  const leftN = leftSize(n);
  const left = await buildStreamNode(pull, leftN);
  const item = await pull();
  if (item === null) {
    throw new BulkBuildError('count-mismatch', 'stream ended before the declared count was reached');
  }
  const right = await buildStreamNode(pull, n - leftN - 1);
  return makeNode(item, left, right);
}

/** Validates the bulk-build input contract: valid ranges, strict (start, end, id) order, unique ids. */
class OrderValidator<V> {
  private prev: Interval<V> | null = null;
  private readonly ids = new Set<string>();

  check(item: Interval<V>): void {
    if (!(item.end >= item.start)) {
      throw new BulkBuildError('invalid-interval', `interval "${item.id}" has end < start`);
    }
    if (this.prev !== null && compareItems(this.prev, item) >= 0) {
      throw new BulkBuildError('unordered', 'stream is not strictly sorted by (start, end, id)');
    }
    if (this.ids.has(item.id)) {
      throw new BulkBuildError('duplicate-id', `duplicate id "${item.id}"`);
    }
    this.ids.add(item.id);
    this.prev = item;
  }
}

/** Default temporary storage: an in-memory buffer. */
class ArrayTempStore<V> implements TempStore<V> {
  private buf: Interval<V>[] | null = [];

  get length(): number {
    return this.buf === null ? 0 : this.buf.length;
  }

  push(item: Interval<V>): void {
    if (this.buf === null) throw new Error('temp store already disposed');
    this.buf.push(item);
  }

  get(index: number): Interval<V> {
    if (this.buf === null) throw new Error('temp store already disposed');
    return this.buf[index];
  }

  dispose(): void {
    this.buf = null;
  }
}

function toAsyncIterator<V>(stream: AsyncIterable<V> | Iterable<V>): AsyncIterator<V> {
  const asyncMethod = (stream as AsyncIterable<V>)[Symbol.asyncIterator];
  if (typeof asyncMethod === 'function') return asyncMethod.call(stream);
  const it = (stream as Iterable<V>)[Symbol.iterator]();
  const wrapper: AsyncIterator<V> = { next: () => Promise.resolve(it.next()) };
  if (it.return) wrapper.return = (value?: unknown) => Promise.resolve(it.return!(value));
  return wrapper;
}

export class IntervalIndex<V> {
  private root: IntervalNode<V> | null;

  constructor(items: Iterable<Interval<V>> = []) {
    let root: IntervalNode<V> | null = null;
    for (const item of items) {
      assertRange(item);
      root = insertNode(root, item);
    }
    this.root = root;
  }

  private static fromRoot<V>(root: IntervalNode<V> | null): IntervalIndex<V> {
    const index = new IntervalIndex<V>();
    index.root = root;
    return index;
  }

  /**
   * Builds an index in linear time from a stream of intervals strictly
   * sorted by `(start, end, id)` with unique ids.
   *
   * The build is atomic: stream failures, count mismatches and
   * cancellation reject the promise and never publish a partial root.
   */
  static async bulkBuild<V>(
    stream: AsyncIterable<Interval<V>> | Iterable<Interval<V>>,
    options: BulkBuildOptions<V> = {},
  ): Promise<IntervalIndex<V>> {
    const { count, signal, tempBudget = Infinity } = options;
    signal?.throwIfAborted();
    const validator = new OrderValidator<V>();

    if (count !== undefined) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('count must be a non-negative safe integer');
      }
      // Known count: the shape is fixed up front, items are placed as they
      // arrive and no temporary storage is needed.
      const it = toAsyncIterator(stream);
      const pull = async (): Promise<Interval<V> | null> => {
        signal?.throwIfAborted();
        const r = await it.next();
        if (r.done) return null;
        validator.check(r.value);
        return r.value;
      };
      try {
        const root = await buildStreamNode(pull, count);
        if ((await pull()) !== null) {
          throw new BulkBuildError(
            'count-mismatch',
            `stream produced more items than the declared count ${count}`,
          );
        }
        signal?.throwIfAborted();
        return IntervalIndex.fromRoot(root);
      } finally {
        // Best-effort release of the source; never masks the build outcome.
        try {
          await it.return?.();
        } catch {
          /* ignored */
        }
      }
    }

    // Unknown count: counting pass through bounded temporary storage, then
    // a deterministic build from the materialized items.
    const store = options.tempStore ? options.tempStore() : new ArrayTempStore<V>();
    let root: IntervalNode<V> | null = null;
    try {
      for await (const item of stream) {
        signal?.throwIfAborted();
        validator.check(item);
        if (store.length >= tempBudget) {
          throw new BulkBuildError(
            'budget-exceeded',
            `temporary storage budget of ${tempBudget} exceeded`,
          );
        }
        store.push(item);
      }
      signal?.throwIfAborted();
      root = buildBalanced((i) => store.get(i), 0, store.length);
    } finally {
      store.dispose();
    }
    return IntervalIndex.fromRoot(root);
  }

  /** Returns a new index with `item` added; an identical key replaces the payload. */
  add(item: Interval<V>): IntervalIndex<V> {
    assertRange(item);
    return IntervalIndex.fromRoot(insertNode(this.root, item));
  }

  /** Returns a new index without the intervals carrying `id`. */
  remove(id: string): IntervalIndex<V> {
    if (this.root === null) return this;
    const all: Interval<V>[] = [];
    collect(this.root, all);
    const kept = all.filter((item) => item.id !== id);
    if (kept.length === all.length) return this;
    return IntervalIndex.fromRoot(buildBalanced((i) => kept[i], 0, kept.length));
  }

  /** All intervals overlapping `[start, end)`, sorted by `(start, end, id)`. */
  overlap(start: number, end: number): Interval<V>[] {
    const out: Interval<V>[] = [];
    queryOverlap(this.root, start, end, out);
    return out;
  }

  /** All intervals, sorted by `(start, end, id)`. */
  toArray(): Interval<V>[] {
    const out: Interval<V>[] = [];
    collect(this.root, out);
    return out;
  }

  size(): number {
    return this.root === null ? 0 : this.root.size;
  }

  /** Tree height; ceil(log2(n + 1)) for bulk-built trees, O(log n) otherwise. */
  height(): number {
    return heightOf(this.root);
  }

  /** Root node for structural inspection, or null when empty. */
  rootNode(): IntervalNode<V> | null {
    return this.root;
  }
}
