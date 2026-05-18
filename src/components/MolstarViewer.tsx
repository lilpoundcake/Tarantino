import { useEffect, useRef } from 'react'
import { createPluginUI } from 'molstar/lib/mol-plugin-ui'
import { renderReact18 } from 'molstar/lib/mol-plugin-ui/react18'
import { DefaultPluginUISpec } from 'molstar/lib/mol-plugin-ui/spec'
import { PluginConfig } from 'molstar/lib/mol-plugin/config'
import { PluginCommands } from 'molstar/lib/mol-plugin/commands'
import { ColorNames } from 'molstar/lib/mol-util/color/names'
import '../molstar-theme.scss'
import { TarantinoResidueColorThemeProvider } from '../lib/residue-color-theme'
import { useStructureStore, type ViewerSlot } from '../stores/structureStore'
import { extractChains, extractElements, extractMeta } from '../lib/molstar-helpers'

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

      // Set 3D viewport background color (official API)
      const renderer = plugin.canvas3d!.props.renderer
      PluginCommands.Canvas3D.SetSettings(plugin, {
        settings: {
          renderer: { ...renderer, backgroundColor: ColorNames.white },
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

            // Orient camera to PCA axes — same as Mol*'s "Orient Axes" UI button.
            // SUPPRESS camera sync during this so the snapshot doesn't get mirrored
            // to the other viewer mid-orientation (which would either fight a
            // pending orient there, or overwrite its already-correct camera).
            const pluginNow = pluginRef.current
            const storeAtLoad = useStructureStore.getState()
            const wasSyncEnabled = storeAtLoad.cameraSyncEnabled
            if (wasSyncEnabled) storeAtLoad.setCameraSyncEnabled(false)
            setTimeout(() => {
              if (cancelled) return
              PluginCommands.Camera.OrientAxes(pluginNow)
                .catch(() => {})
                .finally(() => {
                  // Restore sync after the orient animation settles
                  setTimeout(() => {
                    if (wasSyncEnabled) useStructureStore.getState().setCameraSyncEnabled(true)
                  }, 600)
                })
            }, 200)
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
        // Clear chains for this slot so AlignmentPanel doesn't list stale entries
        if (isPrimary) setChains([])
        else setSecondaryChains([])
      }
    }
  }, [setPluginForSlot, setChains, setSecondaryChains, setElements, setMeta, setError, isPrimary])

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
