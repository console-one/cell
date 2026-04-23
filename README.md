# @console-one/cell

A **Cell** is a versioned piece of state. You say *what kind of thing it is* (a `DataType` from `@console-one/patchkit`), you back it with *where the bytes live* (the event-sourced engine from `@console-one/source`), and you address it via *how to find it again* (a namespace `Path` + `Monitor` from `@console-one/namespace`). Mutate through the patchkit tracker surface; every mutation is a durable, addressable, range-queryable version.

## What's interesting about it

**Three orthogonal libraries, one composition.** patchkit knows types and patches but not storage. source knows hot/cold tiering and dedup but not what's inside a patch. namespace knows addressing and indexing but not content semantics. Cell is the glue — and the glue is thin, because each of the three was designed around a seam the others can plug into.

**Polymorphic over any patchkit `DataType`.** The same `Cell` class holds text, JSON objects, arrays, sets, numbers — anything patchkit can diff/patch/collate. A `codecFor(type)` helper promotes a patchkit `DataType` into a source `ContentCodec` by delegating `applyPatches` to `collate` + `applyPatch` (which patchkit's own contract laws guarantee round-trips correctly).

**Mutation is synchronous, persistence is async.** `cell.state.role = 'architect'` returns immediately. Internally a Ledger captures the patch + inverse; a Sink enqueues a serial `source.save()` (FIFO-chained so each save's `priorVersion` is the previous save's `newVersion`) and registers a `TimelineKey` with the Monitor. `await cell.flush()` when you need durability before continuing.

**Dual addressing via namespace Path.** `cell.livePath()` emits a STAGE-mode path ("current version on this stage") for build pipelines and deployments. `cell.versionPath(seq)` emits a VERSION-mode path for pinned, reproducible references. `cell.resolve(path)` routes either one back to a durable `Checkpoint<S>`.

**Reopen is free.** Construct another `Cell` over the same path and it loads the durable state through the Monitor + source engine — no reconciliation step, no cache warmup dance. `initialState` is only used when the cell didn't exist before.

## Install

```bash
npm install @console-one/cell @console-one/patchkit @console-one/source @console-one/namespace
```

## Quick start — a text cell

```ts
import { Source as PatchkitSource, Typeset } from '@console-one/patchkit'
import {
  InMemoryPartitionMap, InMemorySortedSet, Metric, Monitor, Path, Table, TimelineKey
} from '@console-one/namespace'
import {
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap as SrcPartitionMap,
  InMemorySortedSet as SrcSortedSet,
  Update
} from '@console-one/source'
import { Cell, codecFor } from '@console-one/cell'

// 1. patchkit: declare the type of thing the cell holds.
const ts = new Typeset('cells')
const type = new PatchkitSource(ts, 'text')
const codec = codecFor(type)

// 2. source: stand up an event-sourced engine behind the codec.
const updateDao = new Dao.Update.Default(
  new SrcPartitionMap<Update<any>>(),
  new SrcSortedSet<number>()
)
const checkpointDao = new Dao.Checkpoint.Default(new InMemoryBlobStore(), updateDao, codec)
const view = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, codec, 3, 20)

// 3. namespace: declare the index + build the Monitor.
const metric = Metric.builder().partitionBy('workspace', 'cellKey').as('by-cell').build()
const monitor = new Monitor(
  'cells',
  [metric],
  new InMemorySortedSet<TimelineKey>(tlk => tlk.seq),
  new InMemoryPartitionMap<TimelineKey>(),
  new InMemoryPartitionMap<any>()
)

// 4. open a cell.
const cell = await Cell.open({
  path: Path.fromString('docs/overview.md/LIVE'),
  type,
  view,
  monitor,
  metricName: 'by-cell',
  workspace: 'main',
  initialState: { text: 'hello' }
})

// 5. mutate through the patchkit tracker.
cell.state.insert(5, ' world')
cell.state.insert(11, '!')
await cell.flush()

// 6. resolve.
const live = await cell.resolve(cell.livePath())
console.log(live.content.text)   // 'hello world!'

// Pin to a version:
const pinned = await cell.resolve(cell.versionPath(/* seq */ 1712345678000))
```

## Quick start — an object cell

Swap patchkit's `Source` for `ObjectType`; everything else is the same.

```ts
import { ObjectType, Typeset } from '@console-one/patchkit'
import { Cell, codecFor } from '@console-one/cell'

const type = new ObjectType(new Typeset('cells'))
const codec = codecFor(type)
// ...build `view`, `monitor` exactly as above with this codec...

const cell = await Cell.open({
  path: Path.fromString('users/ac/LIVE'),
  type,
  view,
  monitor,
  metricName: 'by-cell',
  workspace: 'main',
  initialState: { __type: 'object:state', name: 'Andrew', role: 'engineer' }
})

cell.state.role = 'architect'      // proxy captures a nested ObjectPatch
cell.state.tier = 'senior'
await cell.flush()

const live = await cell.resolve(cell.livePath())
console.log(live.content.role)     // 'architect'
```

The proxy surface (`cell.state`) captures even deep nested mutations correctly — see patchkit's README on `Ledger` for what the tracker surface looks like per type.

## Addressing: STAGE vs VERSION

`namespace` paths carry two modes:

- `docs/overview.md/LIVE` — **STAGE mode**. `cell.resolve` consults the Monitor for the current TimelineKey at that stage and loads it. Right for "current live version" in dashboards, deploy pipelines, CDN rewrites.
- `docs/overview.md/1712345678000` — **VERSION mode**. `cell.resolve` loads that exact version directly. Right for reproducible build inputs, audit links, change comparisons.

Both paths resolve through the same `cell.resolve(path)` call — the mode determines the lookup strategy, the return type (`Checkpoint<S>`) is identical.

## Range-query the history

```ts
for await (const batch of cell.readTimelineKeys({ start: 1712345000000, end: 1712346000000 })) {
  for (const tlk of batch) console.log(tlk.toString()) // e.g. 'object:users/ac:1712345678000'
}
```

The underlying sorted set is range-read by seq, so this is one storage scan — not an N+1 walk per version.

## Reopening an existing cell

```ts
const a = await Cell.open({ /* ... */, initialState: { text: 'alpha' } })
a.state.insert(5, '-beta')
await a.flush()

const b = await Cell.open({ /* same path */, initialState: { text: 'IGNORED' } })
b.snapshot // { text: 'alpha-beta' }  — durable state wins; initialState is ignored
b.history  // [] — b's local Ledger history starts empty after reopen
```

## Public surface

- **`Cell<S, P, T>`** — the composed cell.
  - `open(opts, codecOptions?)` — static async constructor.
  - `state: T` — patchkit tracker surface (Proxy or typed handle).
  - `snapshot: S` — raw current state.
  - `ledger` — the underlying patchkit `Ledger` (for `rollback`, `checkpoint`, `restore`, local `history`).
  - `livePath(stage?)` / `versionPath(seq)` — emit namespace `Path`s.
  - `resolve(path)` — STAGE or VERSION path → `Checkpoint<S>`.
  - `readTimelineKeys(range?)` — async iterate versioned history via Monitor.
  - `flush()` — await the in-flight save chain.
- **`codecFor<S, P>(type, opts?)`** — patchkit `DataType` → source `ContentCodec`. Override `serializeState`/`deserializeState`/`serializePatch`/`deserializePatch` for types whose state doesn't round-trip through JSON (e.g. `SetType`).

## Custom serialization (e.g. `SetType`)

patchkit's `SetType` holds a native `Set` which JSON doesn't handle:

```ts
import { SetType, Typeset } from '@console-one/patchkit'
import { codecFor } from '@console-one/cell'

const type = new SetType(new Typeset('cells'))
const codec = codecFor(type, {
  serializeState: (s) => JSON.stringify([...s]),
  deserializeState: (raw) => new Set(JSON.parse(raw))
})
```

## Layout

```
src/
├── index.ts       # Public surface
├── cell.ts        # Cell class — open, state, resolve, readTimelineKeys, flush
├── codec.ts       # codecFor(type, opts) — patchkit DataType → source ContentCodec
└── smoke.ts       # End-to-end smoke: text cell, object cell, reopen
```

## Smoke test

```bash
npm install
npm run build
npm run smoke
```

Three paths:

1. **Text cell** — mutate via `PatchkitSource` tracker → save via source engine → resolve via namespace Path (LIVE and pinned VERSION) → range-query the history.
2. **Object cell** — same pipeline with `ObjectType`; proves polymorphism.
3. **Reopen** — a new `Cell` on the same path picks up durable state and ignores `initialState`.

## License

MIT
