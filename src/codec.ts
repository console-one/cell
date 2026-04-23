import type { DataType } from '@console-one/patchkit'
import type { ContentCodec } from '@console-one/source'

export interface CodecOptions<S, P> {
  /** Override state serialization. Default is `JSON.stringify`. Needed for
   *  types whose state doesn't round-trip through JSON (e.g. `Set`). */
  serializeState?: (state: S) => string
  /** Counterpart to {@link serializeState}. Default is `JSON.parse`. */
  deserializeState?: (raw: string) => S
  /** Override patch serialization. Default is `JSON.stringify`. */
  serializePatch?: (patch: P) => unknown
  /** Counterpart to {@link serializePatch}. Default is identity. */
  deserializePatch?: (raw: unknown) => P
}

/**
 * Bridge a patchkit `DataType` into a source `ContentCodec`.
 *
 * - `applyPatches` uses `type.collate(...)` + `type.applyPatch(...)` so the
 *   engine can fold N patches into one replay step per checkpoint step.
 *   Patchkit's collate-associativity law guarantees this is equivalent to
 *   applying them one by one.
 * - `empty` uses `type.nonceState()`.
 * - JSON is the default serialization for both state and patch; override
 *   via {@link CodecOptions} for types like `SetType` whose state is a `Set`
 *   and doesn't JSON-round-trip.
 */
export function codecFor<S, P>(
  type: DataType<S, P, unknown, unknown>,
  opts: CodecOptions<S, P> = {}
): ContentCodec<S, P> {
  const serializeState = opts.serializeState ?? ((s: S) => JSON.stringify(s))
  const deserializeState = opts.deserializeState ?? ((raw: string) => JSON.parse(raw) as S)
  const patchToJSON = opts.serializePatch ?? ((p: P) => p as unknown)
  const patchFromJSON = opts.deserializePatch ?? ((raw: unknown) => raw as P)

  return {
    empty: () => type.nonceState(),
    applyPatches: (state, patches) => {
      if (patches.length === 0) return state
      const merged = patches.length === 1 ? patches[0] : type.collate(patches)
      return type.applyPatch(merged, state).state
    },
    serialize: serializeState,
    deserialize: deserializeState,
    patchToJSON,
    patchFromJSON
  }
}
