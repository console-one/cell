/**
 * End-to-end smoke: patchkit DataType + source (generalized) engine +
 * namespace Monitor, composed through Cell.
 *
 *   1. Text cell: a Source (patchkit's character-index DataType) backed
 *      by the generalized source engine, with the cell registered against
 *      a namespace Monitor under a declared Metric. Mutate via the
 *      patchkit tracker surface, flush, then resolve the LIVE Path +
 *      pinned VERSION Path back to the checkpoint content.
 *
 *   2. Object cell: same plumbing, different DataType. Proves the
 *      composition is polymorphic — one Cell class, three libraries, any
 *      patchkit type.
 *
 * Exits non-zero on any assertion failure.
 */

import {
  ObjectType,
  Source as PatchkitSource,
  Typeset
} from '@console-one/patchkit'
import {
  InMemoryPartitionMap as NsPartitionMap,
  InMemorySortedSet as NsSortedSet,
  Metric,
  Monitor,
  Path,
  Table,
  TimelineKey
} from '@console-one/namespace'
import {
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap as SrcPartitionMap,
  InMemorySortedSet as SrcSortedSet,
  Update
} from '@console-one/source'

import { Cell, codecFor } from './index.js'

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`[smoke] assertion failed: ${msg}`)
}

function buildMonitor(): Monitor {
  const metric = Metric.builder()
    .partitionBy('workspace', 'cellKey')
    .as('by-cell')
    .build()

  const sset = new NsSortedSet<TimelineKey>((tlk: TimelineKey) => tlk.seq)
  const last = new NsPartitionMap<TimelineKey>()
  const listeners = new NsPartitionMap<any>()

  return new Monitor('cells', [metric], sset, last, listeners)
}

function buildTextEngine() {
  const ts = new Typeset('cells')
  const type = new PatchkitSource(ts, 'text')
  const codec = codecFor(type)
  const updateDao = new Dao.Update.Default(
    new SrcPartitionMap<Update<any>>(),
    new SrcSortedSet<number>()
  )
  const checkpointDao = new Dao.Checkpoint.Default(new InMemoryBlobStore(), updateDao, codec)
  const view = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, codec, 3, 20)
  return { type, view }
}

function buildObjectEngine() {
  const ts = new Typeset('cells')
  const type = new ObjectType(ts)
  const codec = codecFor(type)
  const updateDao = new Dao.Update.Default(
    new SrcPartitionMap<Update<any>>(),
    new SrcSortedSet<number>()
  )
  const checkpointDao = new Dao.Checkpoint.Default(new InMemoryBlobStore(), updateDao, codec)
  const view = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, codec, 3, 20)
  return { type, view }
}

// ---------------------------------------------------------------------------
// Case 1: Text cell — patchkit Source + source engine + namespace monitor
// ---------------------------------------------------------------------------
async function caseText() {
  const { type, view } = buildTextEngine()
  const monitor = buildMonitor()

  const cell = await Cell.open({
    path: Path.fromString('docs/overview.md/LIVE'),
    type,
    view,
    monitor,
    metricName: 'by-cell',
    workspace: 'main',
    initialState: { text: 'hello' }
  })

  // Bootstrap is durable immediately after open().
  const liveAfterBootstrap = await cell.resolve(cell.livePath())
  assert(liveAfterBootstrap.content.text === 'hello',
    `bootstrap text mismatch: ${JSON.stringify(liveAfterBootstrap.content)}`)

  const bootstrapVersion = await monitor.state('by-cell', Table.from('main', 'docs/overview.md')) as TimelineKey

  // Mutate via the patchkit tracker surface.
  cell.state.insert(5, ' world')
  cell.state.insert(11, '!')
  await cell.flush()

  // Local snapshot is up to date.
  assert(cell.snapshot.text === 'hello world!',
    `local snapshot: expected 'hello world!', got ${JSON.stringify(cell.snapshot)}`)

  // Durable LIVE resolution matches.
  const live = await cell.resolve(cell.livePath())
  assert(live.content.text === 'hello world!',
    `LIVE resolution: expected 'hello world!', got ${JSON.stringify(live.content)}`)

  // Pinned version resolution: replay to the bootstrap version only.
  const pinned = await cell.resolve(cell.versionPath(bootstrapVersion.seq))
  assert(pinned.content.text === 'hello',
    `VERSION resolution at ${bootstrapVersion.seq}: expected 'hello', got ${JSON.stringify(pinned.content)}`)

  // Range query: the monitor has 3 TimelineKeys (bootstrap + 2 mutations).
  let count = 0
  for await (const batch of cell.readTimelineKeys()) count += batch.length
  assert(count === 3, `expected 3 timeline keys for text cell, got ${count}`)

  console.log(`[smoke] case1 OK — text cell: mutated via patchkit tracker, saved via source engine, addressable via namespace Path; ${count} timeline keys indexed`)
}

// ---------------------------------------------------------------------------
// Case 2: Object cell — same plumbing, different DataType
// ---------------------------------------------------------------------------
async function caseObject() {
  const { type, view } = buildObjectEngine()
  const monitor = buildMonitor()

  const initial = { __type: 'object:state', name: 'Andrew', role: 'engineer' }
  const cell = await Cell.open({
    path: Path.fromString('users/ac/LIVE'),
    type,
    view,
    monitor,
    metricName: 'by-cell',
    workspace: 'main',
    initialState: initial
  })

  const afterBootstrap = await cell.resolve(cell.livePath())
  assert(afterBootstrap.content.name === 'Andrew',
    `bootstrap name: got ${JSON.stringify(afterBootstrap.content)}`)

  // Mutate via the patchkit Object tracker — the proxy surface captures
  // each assignment as a proper ObjectPatch.
  cell.state.role = 'architect'
  cell.state.tier = 'senior'
  cell.state.name = 'andrew-c'

  await cell.flush()

  assert(cell.snapshot.role === 'architect', `local role: ${cell.snapshot.role}`)
  assert(cell.snapshot.tier === 'senior', `local tier: ${cell.snapshot.tier}`)
  assert(cell.snapshot.name === 'andrew-c', `local name: ${cell.snapshot.name}`)

  const live = await cell.resolve(cell.livePath())
  assert(live.content.role === 'architect', `LIVE role: ${JSON.stringify(live.content)}`)
  assert(live.content.tier === 'senior', `LIVE tier: ${JSON.stringify(live.content)}`)
  assert(live.content.name === 'andrew-c', `LIVE name: ${JSON.stringify(live.content)}`)

  console.log(`[smoke] case2 OK — object cell: promotion + rename flowed through patchkit ObjectType proxy -> source engine -> namespace addressing`)
}

// ---------------------------------------------------------------------------
// Case 3: Re-opening an existing cell picks up prior state
// ---------------------------------------------------------------------------
async function caseReopen() {
  const { type, view } = buildTextEngine()
  const monitor = buildMonitor()

  const first = await Cell.open({
    path: Path.fromString('docs/reopen-me/LIVE'),
    type,
    view,
    monitor,
    metricName: 'by-cell',
    workspace: 'main',
    initialState: { text: 'alpha' }
  })
  first.state.insert(5, '-beta')
  await first.flush()
  assert(first.snapshot.text === 'alpha-beta', `first snapshot: ${first.snapshot.text}`)

  // A *new* Cell over the same path should load the durable state.
  const second = await Cell.open({
    path: Path.fromString('docs/reopen-me/LIVE'),
    type,
    view,
    monitor,
    metricName: 'by-cell',
    workspace: 'main',
    initialState: { text: 'THIS-SHOULD-BE-IGNORED' }
  })
  assert(second.snapshot.text === 'alpha-beta',
    `reopened cell should carry durable state; got ${JSON.stringify(second.snapshot)}`)

  // Local history on `second` is empty — it started from durable state.
  assert(second.history.length === 0,
    `reopened cell should have empty local history; got ${second.history.length}`)

  console.log(`[smoke] case3 OK — reopening an existing cell loads durable state and ignores initialState`)
}

async function main() {
  console.log('[smoke] @console-one/cell')
  await caseText()
  await caseObject()
  await caseReopen()
  console.log('[smoke] ALL OK')
}

main().catch(err => {
  console.error('[smoke] FAIL', err)
  process.exit(1)
})
