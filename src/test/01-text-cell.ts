// ─────────────────────────────────────────────────────────────────────────
// Text cell — patchkit Source DataType + source engine + namespace Monitor.
// Mirrors smoke.ts caseText with validator-based assertions.
// ─────────────────────────────────────────────────────────────────────────

import { Source as PatchkitSource, Typeset } from '@console-one/patchkit';
import {
  InMemoryPartitionMap as NsPartitionMap,
  InMemorySortedSet as NsSortedSet,
  Metric,
  Monitor,
  Path,
  Table,
  type TimelineKey,
} from '@console-one/namespace';
import {
  Dao,
  InMemoryBlobStore,
  InMemoryPartitionMap as SrcPartitionMap,
  InMemorySortedSet as SrcSortedSet,
  type Update,
} from '@console-one/source';

import { Cell, codecFor } from '../index.js';

function buildMonitor(): Monitor {
  const metric = Metric.builder().partitionBy('workspace', 'cellKey').as('by-cell').build();
  const sset = new NsSortedSet<TimelineKey>((tlk: TimelineKey) => tlk.seq);
  const last = new NsPartitionMap<TimelineKey>();
  const listeners = new NsPartitionMap<any>();
  return new Monitor('cells', [metric], sset, last, listeners);
}

function buildTextEngine() {
  const ts = new Typeset('cells');
  const type = new PatchkitSource(ts, 'text');
  const codec = codecFor(type);
  const updateDao = new Dao.Update.Default(
    new SrcPartitionMap<Update<any>>(),
    new SrcSortedSet<number>(),
  );
  const checkpointDao = new Dao.Checkpoint.Default(new InMemoryBlobStore(), updateDao, codec);
  const view = new Dao.Code.View.Checkpoint(checkpointDao, updateDao, codec, 3, 20);
  return { type, view };
}

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('open() bootstraps initialState durably', async (validator: any) => {
    const { type, view } = buildTextEngine();
    const monitor = buildMonitor();
    const cell = await Cell.open({
      path: Path.fromString('docs/a.md/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { text: 'hello' },
    });
    const live = await cell.resolve(cell.livePath());
    return validator.expect(live.content.text).toLookLike('hello');
  });

  await test('mutations via patchkit tracker reach durable LIVE after flush', async (validator: any) => {
    const { type, view } = buildTextEngine();
    const monitor = buildMonitor();
    const cell = await Cell.open({
      path: Path.fromString('docs/b.md/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { text: 'hello' },
    });
    cell.state.insert(5, ' world');
    cell.state.insert(11, '!');
    await cell.flush();
    const live = await cell.resolve(cell.livePath());
    return validator.expect({
      snapshot: cell.snapshot.text,
      live: live.content.text,
    }).toLookLike({ snapshot: 'hello world!', live: 'hello world!' });
  });

  await test('VERSION path replays only up to the requested seq', async (validator: any) => {
    const { type, view } = buildTextEngine();
    const monitor = buildMonitor();
    const cell = await Cell.open({
      path: Path.fromString('docs/c.md/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { text: 'hello' },
    });
    const bootstrap = (await monitor.state(
      'by-cell',
      Table.from('main', 'docs/c.md'),
    )) as TimelineKey;
    cell.state.insert(5, ' world');
    await cell.flush();
    const pinned = await cell.resolve(cell.versionPath(bootstrap.seq));
    return validator.expect(pinned.content.text).toLookLike('hello');
  });

  await test('reopening an existing cell loads durable state and ignores initialState', async (validator: any) => {
    const { type, view } = buildTextEngine();
    const monitor = buildMonitor();
    const first = await Cell.open({
      path: Path.fromString('docs/reopen.md/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { text: 'alpha' },
    });
    first.state.insert(5, '-beta');
    await first.flush();
    const second = await Cell.open({
      path: Path.fromString('docs/reopen.md/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { text: 'IGNORED' },
    });
    return validator.expect({
      reloadedText: second.snapshot.text,
      historyEmpty: second.history.length === 0,
    }).toLookLike({ reloadedText: 'alpha-beta', historyEmpty: true });
  });

  await test('readTimelineKeys yields one key per mutation plus bootstrap', async (validator: any) => {
    const { type, view } = buildTextEngine();
    const monitor = buildMonitor();
    const cell = await Cell.open({
      path: Path.fromString('docs/timeline.md/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { text: 'hi' },
    });
    cell.state.insert(2, '!');
    cell.state.insert(3, '!');
    await cell.flush();
    let count = 0;
    for await (const batch of cell.readTimelineKeys()) count += batch.length;
    return validator.expect(count).toLookLike(3);
  });
};
