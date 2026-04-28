// ─────────────────────────────────────────────────────────────────────────
// Object cell — same plumbing as text cell, different patchkit DataType.
// Proves Cell composition is polymorphic across patchkit types.
// ─────────────────────────────────────────────────────────────────────────

import { ObjectType, Typeset } from '@console-one/patchkit';
import {
  InMemoryPartitionMap as NsPartitionMap,
  InMemorySortedSet as NsSortedSet,
  Metric,
  Monitor,
  Path,
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

function buildObjectEngine() {
  const ts = new Typeset('cells');
  const type = new ObjectType(ts);
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
  await test('object cell bootstraps initialState', async (validator: any) => {
    const { type, view } = buildObjectEngine();
    const monitor = buildMonitor();
    const cell = await Cell.open({
      path: Path.fromString('users/x/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { __type: 'object:state', name: 'Andrew', role: 'engineer' },
    });
    const live = await cell.resolve(cell.livePath());
    return validator.expect(live.content.name).toLookLike('Andrew');
  });

  await test('proxy assignments capture as ObjectPatches and reach durable LIVE', async (validator: any) => {
    const { type, view } = buildObjectEngine();
    const monitor = buildMonitor();
    const cell = await Cell.open({
      path: Path.fromString('users/y/LIVE'),
      type, view, monitor,
      metricName: 'by-cell',
      workspace: 'main',
      initialState: { __type: 'object:state', name: 'Andrew', role: 'engineer' },
    });
    cell.state.role = 'architect';
    cell.state.tier = 'senior';
    cell.state.name = 'andrew-c';
    await cell.flush();
    const live = await cell.resolve(cell.livePath());
    return validator.expect({
      role: live.content.role,
      tier: live.content.tier,
      name: live.content.name,
    }).toLookLike({ role: 'architect', tier: 'senior', name: 'andrew-c' });
  });
};
