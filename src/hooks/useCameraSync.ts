import { useEffect } from 'react'
import { useStructureStore } from '../stores/structureStore'
import type { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'

/**
 * Bidirectional camera synchronisation between the primary and secondary
 * 3D viewers.  When the user rotates / zooms / pans either viewer, the
 * other follows.  Toggle via `structureStore.cameraSyncEnabled`.
 *
 * Mechanism: subscribe to each plugin's `canvas3d.didDraw` BehaviorSubject,
 * snapshot the camera, and mirror to the other plugin only when the snapshot
 * has actually changed AND we are not currently the source of that change
 * (anti-feedback via per-direction `applying` flags).
 */
export function useCameraSync() {
  const plugin = useStructureStore((s) => s.plugin)
  const secondaryPlugin = useStructureStore((s) => s.secondaryPlugin)
  const enabled = useStructureStore((s) => s.cameraSyncEnabled)

  useEffect(() => {
    if (!enabled || !plugin || !secondaryPlugin || !plugin.canvas3d || !secondaryPlugin.canvas3d) return

    // Anti-feedback via "pending draw" flags. When we mirror A→B by
    // calling `B.setState(snap, 0) + B.requestDraw()`, B will emit a
    // didDraw on the next animation frame. We mark `pendingFromAToB =
    // true` so subB consumes that flag and skips its mirror (no echo
    // back to A). Snap-value equality is NOT used because A's focus
    // animation updates A's snap every frame: by the time B's "echo
    // draw" reaches subB, `lastAppliedToB` has already advanced to the
    // newer snap, so the equality check fails and the echo isn't
    // suppressed — that's how the previous implementation interrupted
    // A's in-flight focus animation. The pending-flag pattern is
    // value-independent and survives an animation that fires several
    // didDraw events in a row.
    let pendingFromAToB = false
    let pendingFromBToA = false

    const mirror = (
      src: PluginUIContext,
      dst: PluginUIContext,
      consumePendingOnSrc: () => boolean,
      setPendingOnDst: (b: boolean) => void,
    ) => {
      if (consumePendingOnSrc()) return        // This draw is our own echo — skip.
      if (!src.canvas3d || !dst.canvas3d) return
      // Don't mirror FROM an empty viewer — its camera state is meaningless
      // defaults (tiny radiusMax, origin target), and pushing those onto a
      // viewer that DOES have a structure would freeze the destination at
      // a useless zoom level. Common scenario: user opens structure on A
      // while B is still empty; B's idle didDraw events would otherwise
      // mirror its empty default state onto A.
      if (src.managers.structure.hierarchy.current.structures.length === 0) return
      const srcSnap = src.canvas3d.camera.getSnapshot()
      setPendingOnDst(true)
      // 0ms duration: instant mirror, no animation flicker.
      dst.canvas3d.camera.setState(srcSnap, 0)
      dst.canvas3d.requestDraw()
    }

    const subA = plugin.canvas3d.didDraw.subscribe(() => {
      mirror(
        plugin, secondaryPlugin,
        () => { if (pendingFromBToA) { pendingFromBToA = false; return true } return false },
        b => { pendingFromAToB = b },
      )
    })
    const subB = secondaryPlugin.canvas3d.didDraw.subscribe(() => {
      mirror(
        secondaryPlugin, plugin,
        () => { if (pendingFromAToB) { pendingFromAToB = false; return true } return false },
        b => { pendingFromBToA = b },
      )
    })

    return () => {
      subA.unsubscribe()
      subB.unsubscribe()
    }
  }, [plugin, secondaryPlugin, enabled])
}

