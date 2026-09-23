/**
 * Persistent interval index.
 *
 * The index is an immutable AVL tree keyed by (start, end, id) and augmented
 * with the maximum `end` of each subtree, so overlap queries prune branches
 * that cannot contain matches. Every operation returns a new index and leaves
 * the receiver untouched, which makes indexes cheap to share and snapshot.
 */
export type Interval<V> = { id: string; start: number; end: number; value: V };

/** Machine-readable failure codes for {@link IntervalIndex.bulkBuild}. */
export type BulkBuildErrorCode =
  | 'invalid-range' // an interval had end < start
  | 'unsorted' // stream was not strictly ordered by (start, end, id)
  | 'duplicate-id' // two intervals shared an id
  | 'count-mismatch' // stream length differed from the declared count
  | 'budget-exceeded' // temp store grew past its budget
  | 'aborted'; // the AbortSignal fired

/** Error thrown by {@link IntervalIndex.bulkBuild}; `code` is stable and machine-readable. */
export class BulkBuildError extends Error {
  constructor(
    readonly code: BulkBuildErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BulkBuildError';
  }
}

/**
 * Spill-over storage for the counting phase of {@link IntervalIndex.bulkBuild}
 * when no `count` is known up front. Implementations may buffer in memory, on
 * disk, or anywhere else, as long as they enforce their own budget by throwing
 * `BulkBuildError` with code 'budget-exceeded' from {@link BulkTempStore.append}.
 */
export interface BulkTempStore<V> {
  /** Number of buffered items. */
  readonly size: number;
  /** Buffer one item. */
  append(item: Interval<V>): void | Promise<void>;
  /** Replay all buffered items in append order. */
  iterator(): AsyncIterable<Interval<V>>;
  /** Release resources. Called exactly once, on success and on failure. */
  dispose(): void | Promise<void>;
}

/** Options for {@link IntervalIndex.bulkBuild}. */
export interface BulkBuildOptions<V> {
  /**
   * Exact number of items the stream will produce. When given, the tree shape
   * is fixed up front and the stream is consumed in a single pass with no
   * buffering; too few or too many items fail the build with 'count-mismatch'.
   * When omitted, the stream is drained into a temp store first (the counting
   * phase) and the tree is built from the replay.
   */
  count?: number;
  /** Cancellation; an aborted signal fails the build with code 'aborted'. */
  signal?: AbortSignal;
  /** Custom temp store for the counting phase. Always disposed afterwards. */
  tempStore?: BulkTempStore<V>;
  /** Item budget of the default in-memory temp store. Defaults to 2^20. */
  maxBufferedItems?: number;
}

interface Node<V> {
  readonly item: Interval<V>;
  readonly left: Node<V> | null;
  readonly right: Node<V> | null;
  readonly height: number;
  readonly size: number;
  readonly maxEnd: number;
}

const heightOf = <V>(node: Node<V> | null): number => (node === null ? 0 : node.height);
const sizeOf = <V>(node: Node<V> | null): number => (node === null ? 0 : node.size);
const maxEndOf = <V>(node: Node<V> | null): number =>
  node === null ? Number.NEGATIVE_INFINITY : node.maxEnd;

function makeNode<V>(item: Interval<V>, left: Node<V> | null, right: Node<V> | null): Node<V> {
  return {
    item,
    left,
    right,
    height: 1 + Math.max(heightOf(left), heightOf(right)),
    size: 1 + sizeOf(left) + sizeOf(right),
    maxEnd: Math.max(item.end, maxEndOf(left), maxEndOf(right)),
  };
}

/** Total order on intervals: start, then end, then id (code-unit order). */
function compareInterval<V>(a: Interval<V>, b: Interval<V>): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function rotateLeft<V>(node: Node<V>): Node<V> {
  const right = node.right!;
  return makeNode(right.item, makeNode(node.item, node.left, right.left), right.right);
}

function rotateRight<V>(node: Node<V>): Node<V> {
  const left = node.left!;
  return makeNode(left.item, left.left, makeNode(node.item, left.right, node.right));
}

function balanceOf<V>(node: Node<V>): number {
  return heightOf(node.left) - heightOf(node.right);
}

function rebalance<V>(node: Node<V>): Node<V> {
  const balance = balanceOf(node);
  if (balance > 1) {
    const left = node.left!;
    return rotateRight(
      balanceOf(left) < 0 ? makeNode(node.item, rotateLeft(left), node.right) : node,
    );
  }
  if (balance < -1) {
    const right = node.right!;
    return rotateLeft(
      balanceOf(right) > 0 ? makeNode(node.item, node.left, rotateRight(right)) : node,
    );
  }
  return node;
}

function insertNode<V>(node: Node<V> | null, item: Interval<V>): Node<V> {
  if (node === null) return makeNode(item, null, null);
  const c = compareInterval(item, node.item);
  if (c === 0) throw new Error('duplicate');
  return rebalance(
    c < 0
      ? makeNode(node.item, insertNode(node.left, item), node.right)
      : makeNode(node.item, node.left, insertNode(node.right, item)),
  );
}

function minNode<V>(node: Node<V>): Node<V> {
  let current = node;
  while (current.left !== null) current = current.left;
  return current;
}

function removeNode<V>(node: Node<V> | null, item: Interval<V>): Node<V> | null {
  if (node === null) return null;
  const c = compareInterval(item, node.item);
  if (c < 0) return rebalance(makeNode(node.item, removeNode(node.left, item), node.right));
  if (c > 0) return rebalance(makeNode(node.item, node.left, removeNode(node.right, item)));
  if (node.left === null) return node.right;
  if (node.right === null) return node.left;
  const successor = minNode(node.right);
  return rebalance(makeNode(successor.item, node.left, removeNode(node.right, successor.item)));
}

/** In-order traversal collecting intervals overlapping [start, end), pruning by maxEnd. */
function collectOverlap<V>(
  node: Node<V> | null,
  start: number,
  end: number,
  out: Interval<V>[],
): void {
  if (node === null || node.maxEnd <= start) return;
  collectOverlap(node.left, start, end, out);
  // This node and everything to its right starts at or after node.item.start.
  if (node.item.start >= end) return;
  if (node.item.end > start) out.push(node.item);
  collectOverlap(node.right, start, end, out);
}

function collectById<V>(node: Node<V> | null, id: string, out: Interval<V>[]): void {
  if (node === null) return;
  collectById(node.left, id, out);
  if (node.item.id === id) out.push(node.item);
  collectById(node.right, id, out);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BulkBuildError('aborted', 'bulk build aborted');
}

/** Per-item checks applied while a tree is filled from a stream. */
interface BuildGuard<V> {
  /** Called once per consumed item, in stream order. */
  item(item: Interval<V>): void;
  /** Called at node boundaries so implementations can observe cancellation. */
  tick(): void;
}

/** Validates the stream contract: valid ranges, strict (start, end, id) order, unique ids. */
class ValidatingGuard<V> implements BuildGuard<V> {
  private prev: Interval<V> | null = null;
  private readonly ids = new Set<string>();

  constructor(private readonly signal: AbortSignal | undefined) {}

  tick(): void {
    throwIfAborted(this.signal);
  }

  item(item: Interval<V>): void {
    this.tick();
    if (item.end < item.start) {
      throw new BulkBuildError('invalid-range', `interval "${item.id}" has end < start`);
    }
    if (this.prev !== null && compareInterval(this.prev, item) >= 0) {
      throw new BulkBuildError('unsorted', 'stream is not strictly sorted by (start, end, id)');
    }
    if (this.ids.has(item.id)) {
      throw new BulkBuildError('duplicate-id', `duplicate id "${item.id}"`);
    }
    this.ids.add(item.id);
    this.prev = item;
  }
}

/** Only observes cancellation; used when replaying an already validated temp store. */
class AbortOnlyGuard<V> implements BuildGuard<V> {
  constructor(private readonly signal: AbortSignal | undefined) {}

  tick(): void {
    throwIfAborted(this.signal);
  }

  item(): void {
    this.tick();
  }
}

const DEFAULT_MAX_BUFFERED_ITEMS = 1 << 20;

class MemoryTempStore<V> implements BulkTempStore<V> {
  private items: Interval<V>[] = [];

  constructor(private readonly budget: number) {}

  get size(): number {
    return this.items.length;
  }

  append(item: Interval<V>): void {
    if (this.items.length >= this.budget) {
      throw new BulkBuildError(
        'budget-exceeded',
        `temp store budget of ${this.budget} items exceeded`,
      );
    }
    this.items.push(item);
  }

  async *iterator(): AsyncIterable<Interval<V>> {
    yield* this.items;
  }

  dispose(): void {
    this.items = [];
  }
}

/**
 * Fill a perfectly balanced tree of `n` nodes by pulling items in-order from
 * `it`. The shape depends only on `n` (left subtree gets floor(n/2) nodes), so
 * the result is deterministic and its height is floor(log2(n)) + 1.
 */
async function fillNode<V>(
  it: AsyncIterator<Interval<V>>,
  n: number,
  guard: BuildGuard<V>,
): Promise<Node<V> | null> {
  if (n === 0) return null;
  const leftN = n >> 1;
  const left = await fillNode(it, leftN, guard);
  guard.tick();
  const r = await it.next();
  if (r.done) {
    throw new BulkBuildError('count-mismatch', `stream ended ${n} item(s) before the declared count`);
  }
  guard.item(r.value);
  const right = await fillNode(it, n - 1 - leftN, guard);
  return makeNode(r.value, left, right);
}

async function closeQuietly<V>(it: AsyncIterator<V>): Promise<void> {
  try {
    await it.return?.();
  } catch {
    // The source failed already; its original error is the one we propagate.
  }
}

export class IntervalIndex<V> {
  constructor(private readonly root: Node<V> | null = null) {}

  /** Number of intervals in the index. */
  size(): number {
    return sizeOf(this.root);
  }

  /** Height of the underlying tree; 0 for an empty index. Exposed for balance diagnostics. */
  height(): number {
    return heightOf(this.root);
  }

  /** Largest `end` in the index; -Infinity when empty. */
  maxEnd(): number {
    return maxEndOf(this.root);
  }

  add(item: Interval<V>): IntervalIndex<V> {
    if (item.end < item.start) throw new Error('range');
    return new IntervalIndex<V>(insertNode(this.root, item));
  }

  remove(id: string): IntervalIndex<V> {
    const doomed: Interval<V>[] = [];
    collectById(this.root, id, doomed);
    if (doomed.length === 0) return this;
    let root = this.root;
    for (const item of doomed) root = removeNode(root, item);
    return new IntervalIndex<V>(root);
  }

  /** All intervals overlapping [start, end), ordered by (start, end, id). */
  overlap(start: number, end: number): Interval<V>[] {
    const out: Interval<V>[] = [];
    collectOverlap(this.root, start, end, out);
    return out;
  }

  /**
   * Build an index from a stream of intervals in O(n) time.
   *
   * The stream must be strictly ordered by (start, end, id) and ids must be
   * unique; violations fail the build. The tree shape depends only on the item
   * count, so the result is deterministic and always within ceil(log2(n+1))
   * levels, and `maxEnd` is computed per node as the tree is assembled.
   *
   * The build is atomic: a failing stream, a count mismatch, or an aborted
   * signal rejects the promise and no partial index is ever observable.
   * Items are pulled one at a time, so slow sources are never read ahead.
   */
  static async bulkBuild<V>(
    stream: AsyncIterable<Interval<V>>,
    options: BulkBuildOptions<V> = {},
  ): Promise<IntervalIndex<V>> {
    const { count, signal } = options;
    throwIfAborted(signal);
    if (count !== undefined && (!Number.isInteger(count) || count < 0)) {
      throw new BulkBuildError('count-mismatch', 'count must be a non-negative integer');
    }

    if (count !== undefined) {
      // Known shape: single pass, no buffering.
      const it = stream[Symbol.asyncIterator]();
      try {
        const root = await fillNode(it, count, new ValidatingGuard<V>(signal));
        const extra = await it.next();
        if (!extra.done) {
          throw new BulkBuildError(
            'count-mismatch',
            `stream produced more than the declared count of ${count}`,
          );
        }
        return new IntervalIndex<V>(root);
      } catch (e) {
        await closeQuietly(it);
        throw e;
      }
    }

    // Counting phase: drain into bounded temp storage, then build from the replay.
    const store =
      options.tempStore ??
      new MemoryTempStore<V>(options.maxBufferedItems ?? DEFAULT_MAX_BUFFERED_ITEMS);
    try {
      const guard = new ValidatingGuard<V>(signal);
      for await (const item of stream) {
        guard.item(item);
        await store.append(item);
      }
      const root = await fillNode(
        store.iterator()[Symbol.asyncIterator](),
        store.size,
        new AbortOnlyGuard<V>(signal),
      );
      return new IntervalIndex<V>(root);
    } finally {
      await store.dispose();
    }
  }
}
