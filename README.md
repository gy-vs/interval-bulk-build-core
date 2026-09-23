# Persistent interval index

TypeScript library for interval storage and queries.

Intervals live in an immutable balanced tree ordered by `(start, end, id)` and
augmented with a per-node `maxEnd`, so `overlap(start, end)` costs
O(log n + k) and returns matches sorted by `(start, end, id)`. `add`/`remove`
copy the path and return a new index — older versions keep working.

Run `npm install`, then `npm test` and `npm run build`.

## Bulk build

`IntervalIndex.bulkBuild(stream, options?)` builds a balanced tree in linear
time from an async stream of intervals, avoiding per-item inserts.

Input contract (validated while streaming; violations reject with a
`BulkBuildError` carrying a `code`):

- every item satisfies `end >= start` (`invalid-interval`),
- items are strictly sorted by `(start, end, id)` (`unordered`),
- ids are unique (`duplicate-id`).

The tree shape is deterministic for a given item count (a complete tree of
height `ceil(log2(n+1))`), and `maxEnd` is computed per node during the build.

- `count`: when the count is known, items are placed directly as they arrive
  (O(log n) working space, demand-driven pulling). Fewer or more items than
  declared fails with `count-mismatch`.
- Without `count`, a counting pass buffers items in temporary storage, then
  builds. `tempBudget` bounds the buffer (`budget-exceeded`); a custom
  `tempStore` can be injected. Temporary storage is always disposed,
  including after failures.
- `signal`: aborts the build between items.

The build is atomic: stream failures, count mismatches and cancellation
reject the promise and never publish a partial root.

```ts
const index = await IntervalIndex.bulkBuild(stream, { count: 1_000_000 });
const hits = index.overlap(10, 20);
```
