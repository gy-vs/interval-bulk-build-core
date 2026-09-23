# Persistent interval index

TypeScript library for interval storage and queries.

The index is an immutable AVL tree keyed by `(start, end, id)` and augmented
with the maximum `end` of each subtree, so `overlap` prunes branches that
cannot contain matches. `add` / `remove` return a new index and never mutate
the receiver.

Run `npm install`, then `npm test` and `npm run build`.

## Bulk build

`IntervalIndex.bulkBuild(stream, options)` builds a balanced index from an
async stream of intervals in O(n) time, instead of inserting item by item.

```ts
const index = await IntervalIndex.bulkBuild(stream, { count: items.length });
```

- The stream must be **strictly ordered by `(start, end, id)`** and **ids must
  be unique**; violations reject the promise with a `BulkBuildError`
  (`code`: `'unsorted'`, `'duplicate-id'`, `'invalid-range'`).
- The tree shape depends only on the item count, so the result is
  deterministic and its height stays within `ceil(log2(n+1))`; `maxEnd` is
  computed per node as the tree is assembled.
- **Known count** (`options.count`): single pass, no buffering. A stream that
  is too short or too long fails with `'count-mismatch'`; extra items are
  detected after `count + 1` pulls and the source is closed without draining.
- **Unknown count**: the stream is first drained into a temp store (the
  counting phase), then the tree is built from the replay. The default
  in-memory store is bounded by `options.maxBufferedItems` (default 2^20) and
  fails with `'budget-exceeded'`; pass `options.tempStore` (see
  `BulkTempStore`) for custom spill-over storage. The store is always
  disposed, on success and on failure.
- Items are pulled one at a time, so slow sources are never read ahead.
- The build is **atomic**: a failing stream, a count mismatch, or an aborted
  `options.signal` (`'aborted'`) rejects the promise and no partial index is
  ever observable. A failed build can simply be retried with a fresh stream.

Queries on a bulk-built index return the same results, in the same
`(start, end, id)` order, as an index built by repeated `add` calls.
