import { useEffect } from 'react'
import { useStructureStore } from '../stores/structureStore'
import type { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context'
import type { Camera } from 'molstar/lib/mol-canvas3d/camera'

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

    // Last applied snapshot per side — used to detect "this draw was caused by us"
    let lastFromA: Camera.Snapshot | null = null
    let lastFromB: Camera.Snapshot | null = null
    // Per-side suppress flags
    let applyingToB = false
    let applyingToA = false

    const mirror = (
      src: PluginUIContext,
      dst: PluginUIContext,
      lastApplied: Camera.Snapshot | null,
      setLastApplied: (s: Camera.Snapshot) => void,
      setApplyingDst: (b: boolean) => void,
      isApplyingSrc: () => boolean,
    ) => {
      if (isApplyingSrc()) return // suppress: this draw was caused by our own push
      if (!src.canvas3d || !dst.canvas3d) return
      const snap = src.canvas3d.camera.getSnapshot()
      if (lastApplied && snapshotsEqual(snap, lastApplied)) return
      setLastApplied(snap)
      setApplyingDst(true)
      // 0ms duration: instant mirror; no animation flicker
      dst.canvas3d.camera.setState(snap, 0)
      dst.canvas3d.requestDraw()
      // Release suppress on the destination after the next microtask so its
      // didDraw fires while suppress is true and is ignored.
      Promise.resolve().then(() => { setApplyingDst(false) })
    }

    const subA = plugin.canvas3d.didDraw.subscribe(() => {
      mirror(plugin, secondaryPlugin, lastFromA, s => { lastFromA = s }, b => { applyingToB = b }, () => applyingToA)
    })
    const subB = secondaryPlugin.canvas3d.didDraw.subscribe(() => {
      mirror(secondaryPlugin, plugin, lastFromB, s => { lastFromB = s }, b => { applyingToA = b }, () => applyingToB)
    })

    return () => {
      subA.unsubscribe()
      subB.unsubscribe()
    }
  }, [plugin, secondaryPlugin, enabled])
}

function snapshotsEqual(a: Camera.Snapshot, b: Camera.Snapshot): boolean {
  if (a === b) return true
  if (a.mode !== b.mode || a.fov !== b.fov || a.radius !== b.radius) return false
  return vecEq(a.position, b.position) && vecEq(a.target, b.target) && vecEq(a.up, b.up)
}

function vecEq(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return false
  }
  return true
}
