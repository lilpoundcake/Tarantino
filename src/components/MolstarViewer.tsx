import { useEffect, useRef } from 'react'
import { createPluginUI } from 'molstar/lib/mol-plugin-ui'
import { renderReact18 } from 'molstar/lib/mol-plugin-ui/react18'
import { DefaultPluginUISpec } from 'molstar/lib/mol-plugin-ui/spec'
import { PluginConfig } from 'molstar/lib/mol-plugin/config'
import { PluginCommands } from 'molstar/lib/mol-plugin/commands'
import { ColorNames } from 'molstar/lib/mol-util/color/names'
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params'
import '../molstar-theme.scss'
import { TarantinoResidueColorThemeProvider } from '../lib/residue-color-theme'
import { useStructureStore, type ViewerSlot } from '../stores/structureStore'
import { extractChains, extractElements, extractMeta, getFirstStructure } from '../lib/molstar-helpers'

interface MolstarViewerProps {
  /** 'primary' (default) drives all other panels. 'secondary' is an
   *  independent 3D viewer for comparing structures side-by-side. */
  slot?: ViewerSlot
}

export function MolstarViewer({ slot = 'primary' }: MolstarViewerProps) { // @dsp obj-a1000004
  const containerRef = useRef<HTMLDivElement>(null)
  const pluginRef = useRef<Awaited<ReturnType<typeof createPluginUI>> | null>(null)
  const setPlugin = useStructureStore((s) => s.setPlugin)
  const setSecondaryPlugin = useStructureStore((s) => s.setSecondaryPlugin)
  const setChains = useStructureStore((s) => s.setChains)
  const setSecondaryChains = useStructureStore((s) => s.setSecondaryChains)
  const setElements = useStructureStore((s) => s.setElements)
  const setMeta = useStructureStore((s) => s.setMeta)
  const setError = useStructureStore((s) => s.setError)
  const setFileName = useStructureStore((s) => s.setFileName)
  const setSecondaryFileName = useStructureStore((s) => s.setSecondaryFileName)

  const isPrimary = slot === 'primary'
  const setPluginForSlot = isPrimary ? setPlugin : setSecondaryPlugin

  useEffect(() => {
    if (!containerRef.current) return

    let cancelled = false

    const init = async () => {
      const plugin = await createPluginUI({
        target: containerRef.current!,
        render: renderReact18,
        spec: {
          ...DefaultPluginUISpec(),
          config: [
            [PluginConfig.VolumeStreaming.Enabled, false],
          ],
          layout: {
            initial: {
              isExpanded: false,
              showControls: true,
              controlsDisplay: 'reactive',
              regionState: {
                top: 'hidden',
                left: 'collapsed',
                bottom: 'hidden',
                right: 'hidden',
              },
            },
          },
        },
      })

      if (cancelled) {
        plugin.dispose()
        return
      }

      pluginRef.current = plugin
      setPluginForSlot(plugin)

      // Set 3D viewport background color + take exclusive ownership of the
      // camera. `manualReset: true` tells Mol*'s Canvas3D.commitScene to NEVER
      // call resolveCameraReset on its own — otherwise any state-tree update
      // that expands the scene's bounding sphere (e.g. adding a surroundings
      // stick repr from the Sequence/Alignment zoom button) overwrites our
      // explicit camera.focusSphere mid-animation, producing the
      // "jump-and-snap-back" the user sees.
      // See node_modules/molstar/lib/mol-canvas3d/canvas3d.js:commitScene
      // for the auto-reset trigger.
      const renderer = plugin.canvas3d!.props.renderer
      const camera = plugin.canvas3d!.props.camera
      PluginCommands.Canvas3D.SetSettings(plugin, {
        settings: {
          renderer: { ...renderer, backgroundColor: ColorNames.white },
          camera: { ...camera, manualReset: true },
        },
      })

      // Register custom residue type color theme
      plugin.representation.structure.themes.colorThemeRegistry.add(TarantinoResidueColorThemeProvider)

      // Recolor focus representation (sticks) when focus changes
      plugin.managers.structure.focus.behaviors.current.subscribe(() => {
        setTimeout(() => {
          const builder = plugin.state.data.build()
          let hasUpdates = false

          for (const cell of plugin.state.data.cells.values()) {
            const tags = cell.transform.tags ?? []
            if (!tags.includes('structure-focus-target-repr') && !tags.includes('structure-focus-surr-repr')) continue

            const oldParams = cell.transform.params as any
            if (oldParams?.colorTheme?.name === 'tarantino-residue-type') continue

            builder.to(cell.transform.ref).update({
              ...oldParams,
              colorTheme: { name: 'tarantino-residue-type', params: {} },
            })
            hasUpdates = true
          }

          if (hasUpdates) {
            plugin.runTask(plugin.state.data.updateTree(builder))
          }
        }, 150)
      })

      let postLoadDone = false

      plugin.managers.structure.hierarchy.behaviors.selection.subscribe(() => {
        if (cancelled || !pluginRef.current) return

        // The PRIMARY viewer publishes chain/element/meta to the store (drives
        // Sequence/Elements/Interactions/Info). The SECONDARY viewer publishes
        // only its chains — needed by the Alignment panel for cross-structure
        // alignment — but doesn't touch elements/meta/etc.
        const chains = extractChains(pluginRef.current)
        if (isPrimary) {
          setChains(chains)
          setElements(extractElements(pluginRef.current))
          // Auto-extracted name/method are FALLBACKS — only set if the
          // library entry didn't already populate them. We read the
          // current store meta via getState() to compare without
          // re-triggering selectors.
          const extracted = extractMeta(pluginRef.current)
          const current = useStructureStore.getState().meta
          const patch: Partial<{ name: string; method: string }> = {}
          if (!current.name && extracted.name) patch.name = extracted.name
          if (!current.method && extracted.method) patch.method = extracted.method
          if (Object.keys(patch).length > 0) setMeta(patch)
        } else {
          setSecondaryChains(chains)
        }

        // Post-load setup — run once when components with representations appear
        if (!postLoadDone) {
          const allComps = pluginRef.current.managers.structure.hierarchy.current.structures
            .flatMap(s => s.components)
          const readyComps = allComps.filter(c => c.representations.length > 0)

          if (readyComps.length > 0) {
            postLoadDone = true

            // Hide water
            const waterComps = readyComps.filter(c => {
              const label = (c.cell.obj?.label || c.key || '').toLowerCase()
              return label.includes('water')
            })
            if (waterComps.length > 0) {
              pluginRef.current.managers.structure.component.toggleVisibility(waterComps)
            }

            // Render ions as Van der Waals spheres (spacefill). Mol*'s
            // default preset shows ions as a tiny ball-and-stick which is
            // barely visible — spacefill + the physical size theme uses
            // each element's VdW radius, giving a properly-sized colored
            // sphere per ion.
            const ionComps = readyComps.filter(c => {
              const label = (c.cell.obj?.label || c.key || '').toLowerCase()
              return label.includes('ion')
            })
            if (ionComps.length > 0) {
              const structureData = getFirstStructure(pluginRef.current)
              if (structureData) {
                const spacefillParams = createStructureRepresentationParams(pluginRef.current, structureData, {
                  type: 'spacefill',
                })
                const update = pluginRef.current.state.data.build()
                for (const comp of ionComps) {
                  for (const repr of comp.representations) {
                    update.to(repr.cell.transform.ref).update(spacefillParams)
                  }
                }
                pluginRef.current.runTask(pluginRef.current.state.data.updateTree(update)).catch(() => {})
              }
            }

            // Camera positioning on load. Mol*'s built-in auto-fit on first
            // structure (commitScene → resolveCameraReset) is suppressed
            // because we set `manualReset: true` (needed so user-initiated
            // focus animations aren't yanked back by commitScene). So we
            // MUST manually fit the camera here, otherwise the viewer
            // renders a blank canvas until the user clicks empty space
            // (which triggers attachEmptyClickCleanup's camera.reset).
            //
            // Branch:
            // - autoOrientOnLoad ON  → OrientAxes (PCA-aligned view)
            // - autoOrientOnLoad OFF → plain camera.reset (fit-to-scene)
            const pluginNow = pluginRef.current
            const storeAtLoad = useStructureStore.getState()
            const wasSyncEnabled = storeAtLoad.cameraSyncEnabled
            if (storeAtLoad.autoOrientOnLoad) {
              if (wasSyncEnabled) storeAtLoad.setCameraSyncEnabled(false)
              setTimeout(() => {
                if (cancelled) return
                PluginCommands.Camera.OrientAxes(pluginNow)
                  .catch(() => {})
                  .finally(() => {
                    setTimeout(() => {
                      if (wasSyncEnabled) useStructureStore.getState().setCameraSyncEnabled(true)
                    }, 600)
                  })
              }, 200)
            } else {
              // Same sync-suppression dance to avoid mirroring the fit
              // animation into the secondary viewer (which may show a
              // completely different structure).
              if (wasSyncEnabled) storeAtLoad.setCameraSyncEnabled(false)
              setTimeout(() => {
                if (cancelled) return
                pluginNow.managers.camera.reset(undefined, 0)
                setTimeout(() => {
                  if (wasSyncEnabled) useStructureStore.getState().setCameraSyncEnabled(true)
                }, 100)
              }, 50)
            }
          }
        }
      })

      // Reset flag when a new structure is loaded
      plugin.state.data.events.changed.subscribe(() => {
        if (plugin.managers.structure.hierarchy.current.structures.length === 0) {
          postLoadDone = false
        }
      })
    }

    init().catch((err) => {
      if (!cancelled) {
        setError(`Failed to initialize Mol*: ${err.message}`)
      }
    })

    return () => {
      cancelled = true
      if (pluginRef.current) {
        pluginRef.current.dispose()
        pluginRef.current = null
        setPluginForSlot(null)
        // Clear chains AND the loaded-file marker for this slot so the
        // Library doesn't keep showing an A/B chip on a structure whose
        // viewer was just closed, and AlignmentPanel doesn't list stale
        // chain entries.
        if (isPrimary) {
          setChains([])
          setFileName(null)
        } else {
          setSecondaryChains([])
          setSecondaryFileName(null)
          // Snap the Library's A/B toggle back to 'primary' so subsequent
          // Library clicks don't try to load into the now-disposed
          // secondary plugin (which would bail with "Open a '3D
          // Structure (B)' tab first" and trap the user).
          if (useStructureStore.getState().loadTargetSlot === 'secondary') {
            useStructureStore.getState().setLoadTargetSlot('primary')
          }
        }
      }
    }
  }, [setPluginForSlot, setChains, setSecondaryChains, setElements, setMeta, setError, setFileName, setSecondaryFileName, isPrimary])

  // Resize observer to handle panel resize
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver(() => {
      if (pluginRef.current) {
        pluginRef.current.layout.events.updated.next(undefined)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    />
  )
}
