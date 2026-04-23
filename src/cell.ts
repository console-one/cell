import type { DataType } from '@console-one/patchkit'
import { Ledger, ledger, type Sink, type LedgerEntry } from '@console-one/patchkit'
import type { Monitor } from '@console-one/namespace'
import { Path, Table, TimelineKey } from '@console-one/namespace'
import type { ContentCodec, Checkpoint } from '@console-one/source'
import { Dao, SourceID } from '@console-one/source'

import { codecFor, type CodecOptions } from './codec.js'

export interface CellOptions<S, P, T = S> {
  /** The address of the cell. The Cell uses `path.namespace` as the key and
   *  ignores the version/stage tail — addresses in those modes are returned
   *  via {@link Cell.path} / {@link Cell.livePath}. */
  path: Path
  /** Patchkit `DataType` that defines how this cell mutates. The third
   *  type parameter is elided (queries aren't exposed yet); the fourth is
   *  the tracker surface the Ledger will hand back as `cell.state`. */
  type: DataType<S, P, unknown, T>
  /** Event-sourced engine. The caller builds this with the same codec this
   *  Cell uses; passing it in keeps Cells transport-agnostic — one Cell per
   *  artifact, one engine per backing storage. */
  view: Dao.Code.View.Checkpoint<S, P>
  /** Namespace indexer. `metricName` declares which declared partition we
   *  register under. */
  monitor: Monitor
  metricName: string
  /** Stage/workspace the cell publishes under — feeds source's workspace
   *  key (for its workspace sorted set) and namespace's stage list. */
  workspace: string
  /** Optional initial state for a cell being created for the first time. If
   *  a prior version already exists at this path, {@link Cell.open} loads
   *  that instead and ignores this value. */
  initialState?: S
}

const VERSION_MODE = 'VERSION'

/**
 * A versioned cell — the composition of:
 *   - a patchkit `DataType` (what kind of thing this cell holds)
 *   - an event-sourced `source` engine (where the versions live)
 *   - a namespace `Monitor` (how to find this cell + its history again)
 *
 * Mutate `cell.state` through the patchkit tracker surface. Each mutation
 * synchronously commits a patch to a local Ledger AND enqueues a durable
 * save to the engine + monitor registration. Saves are serialized per-cell
 * (a FIFO chain, so each save's `priorVersion` is the previous save's
 * `newVersion`). Mutations return immediately; saves settle asynchronously.
 */
export class Cell<S, P, T = S> {
  readonly path: Path
  readonly type: DataType<S, P, unknown, T>
  readonly ledger: Ledger<S, P, T>
  readonly codec: ContentCodec<S, P>

  private readonly view: Dao.Code.View.Checkpoint<S, P>
  private readonly monitor: Monitor
  private readonly metricName: string
  private readonly workspace: string
  private readonly cellKey: string

  private lastVersion: number | undefined
  private saveChain: Promise<void> = Promise.resolve()
  private _opened = false

  private constructor(opts: CellOptions<S, P, T>, codec: ContentCodec<S, P>, ledgerInstance: Ledger<S, P, T>) {
    this.path = opts.path
    this.type = opts.type
    this.view = opts.view
    this.monitor = opts.monitor
    this.metricName = opts.metricName
    this.workspace = opts.workspace
    this.codec = codec
    this.cellKey = opts.path.namespace
    this.ledger = ledgerInstance

    if (!opts.monitor.metricsByName[opts.metricName]) {
      throw new Error(
        `Cell: metric '${opts.metricName}' is not registered on the provided Monitor. ` +
        `Register it at Monitor construction time.`
      )
    }

    // Wire the Ledger -> (source save + monitor add) pipeline.
    this.ledger.subscribe(this.buildSink())
  }

  /**
   * Build a Cell and restore its state from durable storage (or initialize
   * it if nothing is there yet). Must be awaited before mutating.
   */
  static async open<S, P, T = S>(
    opts: CellOptions<S, P, T>,
    codecOptions: CodecOptions<S, P> = {}
  ): Promise<Cell<S, P, T>> {
    const codec = codecFor<S, P>(opts.type, codecOptions)

    // Try to resolve the cell's current timeline entry.
    const partition = Table.from(opts.workspace, opts.path.namespace)
    const existing = await opts.monitor.state(opts.metricName, partition).catch(() => undefined)

    let initial: S
    let seedPatches: P[] | undefined
    let priorVersion: SourceID | undefined

    if (existing !== undefined) {
      // Cell has history — load the current content and skip the initial save.
      const loaded = await opts.view.load(new SourceID(opts.path.namespace, existing.seq))
      initial = loaded.content
      priorVersion = new SourceID(opts.path.namespace, existing.seq)
    } else {
      // Fresh cell — seed from initialState (or nonceState) and write the
      // first version synchronously so readers can resolve the cell.
      initial = opts.initialState ?? opts.type.nonceState()
      const empty = opts.type.nonceState()
      const bootstrap = opts.type.diff(empty, initial)
      seedPatches = [bootstrap]
    }

    const ledgerInstance = ledger<S, P, T>(initial, { type: opts.type })
    const cell = new Cell<S, P, T>(opts, codec, ledgerInstance)

    if (seedPatches !== undefined) {
      // Synchronous bootstrap: version = now(), no prior. Waits for durability
      // before returning so the cell is externally visible on open().
      const version = cell.nextVersion()
      const newVersion = new SourceID(opts.path.namespace, version)
      await opts.view.save({
        newVersion,
        patches: seedPatches,
        labelChanges: [],
        workspace: opts.workspace
      })
      await opts.monitor.add(
        opts.metricName,
        Table.from(opts.workspace, opts.path.namespace),
        new TimelineKey(opts.type.name, version, opts.path.namespace)
      )
      cell.lastVersion = version
    } else if (priorVersion !== undefined) {
      cell.lastVersion = priorVersion.version
    }

    cell._opened = true
    return cell
  }

  /** Current in-memory state (raw — use `.state` for the tracker surface). */
  get snapshot(): S {
    return this.ledger.snapshot
  }

  /** Mutable tracker surface from patchkit. Mutations here flow through the
   *  Ledger to the source + namespace pipeline. */
  get state(): T {
    return this.ledger.state
  }

  /** Local in-memory history (post-open). Does NOT include the bootstrap
   *  save. For the full durable history use {@link readTimelineKeys}. */
  get history(): readonly LedgerEntry<P>[] {
    return this.ledger.history
  }

  /** A Path addressing this cell's current LIVE state (stage mode). */
  livePath(stage: string = this.workspace): Path {
    return Path.fromString(`${this.cellKey}/${stage}`)
  }

  /** A Path addressing a specific pinned version of this cell. */
  versionPath(version: number): Path {
    return Path.fromString(`${this.cellKey}/${version}`)
  }

  /** Resolve a Path back to a durable checkpoint.
   *  - VERSION mode → load that exact version.
   *  - STAGE mode → consult the monitor for the latest TimelineKey. */
  async resolve(path: Path): Promise<Checkpoint<S>> {
    const type = path.type as string
    if (type === VERSION_MODE) {
      const version = Number(path.version)
      if (!Number.isFinite(version)) {
        throw new Error(`Cell.resolve: path ${path.toString()} has non-numeric version: ${path.version}`)
      }
      return this.view.load(new SourceID(this.cellKey, version))
    }
    // STAGE mode: look up the current timeline head.
    const partition = Table.from(this.workspace, this.cellKey)
    const tlk = await this.monitor.state(this.metricName, partition)
    if (tlk === undefined) {
      throw new Error(`Cell.resolve: no timeline entry for ${this.cellKey} at stage ${path.version ?? this.workspace}`)
    }
    return this.view.load(new SourceID(this.cellKey, tlk.seq))
  }

  /** Range-read TimelineKeys for this cell (versions falling in [start,end]). */
  async *readTimelineKeys(range: { start?: number; end?: number; batchSize?: number } = {}): AsyncGenerator<TimelineKey[]> {
    const partition = Table.from(this.workspace, this.cellKey)
    const gen = this.monitor.readKeys(this.metricName, partition, range)
    for await (const batch of gen) yield batch as TimelineKey[]
  }

  /** Wait for the in-flight save chain to drain. Use this before asserting
   *  durability from outside the Cell. */
  async flush(): Promise<void> {
    await this.saveChain
  }

  private buildSink(): Sink<P> {
    return {
      onEntry: (entry: LedgerEntry<P>) => {
        // Chain saves so each one has a definite priorVersion.
        this.saveChain = this.saveChain.then(async () => {
          // Skip mutations that fire before bootstrap durability — the
          // Ledger constructor calls track() synchronously and
          // subscribe is done in the Cell constructor which happens
          // BEFORE the bootstrap save. No patches can be committed
          // until open() returns though, so this is just defense in
          // depth.
          if (!this._opened && this.lastVersion === undefined) return

          const version = this.nextVersion()
          const newVersion = new SourceID(this.cellKey, version)
          const priorVersion = this.lastVersion !== undefined
            ? new SourceID(this.cellKey, this.lastVersion)
            : undefined

          await this.view.save({
            priorVersion,
            newVersion,
            patches: [entry.patch],
            labelChanges: [],
            workspace: this.workspace
          })
          await this.monitor.add(
            this.metricName,
            Table.from(this.workspace, this.cellKey),
            new TimelineKey(this.type.name, version, this.cellKey)
          )
          this.lastVersion = version
        })
      }
    }
  }

  private _versionCounter = 0
  private nextVersion(): number {
    // Date.now() gives monotonicity across process restarts; the counter
    // breaks ties within a single millisecond.
    const now = Date.now() * 1000
    const candidate = now + this._versionCounter++
    if (this.lastVersion !== undefined && candidate <= this.lastVersion) {
      // Clock went backwards or multiple cells racing — bump past lastVersion.
      return this.lastVersion + 1
    }
    return candidate
  }
}
