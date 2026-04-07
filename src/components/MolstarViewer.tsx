import { useEffect, useRef } from 'react'
import { createPluginUI } from 'molstar/lib/mol-plugin-ui'
import { renderReact18 } from 'molstar/lib/mol-plugin-ui/react18'
import { DefaultPluginUISpec } from 'molstar/lib/mol-plugin-ui/spec'
import { PluginConfig } from 'molstar/lib/mol-plugin/config'
import { PluginCommands } from 'molstar/lib/mol-plugin/commands'
import { ColorNames } from 'molstar/lib/mol-util/color/names'
import '../molstar-theme.scss'
import { TarantinoResidueColorThemeProvider } from '../lib/residue-color-theme'
import { useStructureStore } from '../stores/structureStore'
import { extractChains, extractElements, extractMeta } from '../lib/molstar-helpers'

export function MolstarViewer() { // @dsp obj-a1000004
  const containerRef = useRef<HTMLDivElement>(null)
  const pluginRef = useRef<Awaited<ReturnType<typeof createPluginUI>> | null>(null)
  const setPlugin = useStructureStore((s) => s.setPlugin)
  const setChains = useStructureStore((s) => s.setChains)
  const setElements = useStructureStore((s) => s.setElements)
  const setMeta = useStructureStore((s) => s.setMeta)
  const setError = useStructureStore((s) => s.setError)

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
      setPlugin(plugin)

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

            // Update just the colorTheme in the existing params
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
        if (!cancelled && pluginRef.current) {
          setChains(extractChains(pluginRef.current))
          setElements(extractElements(pluginRef.current))
          const meta = extractMeta(pluginRef.current)
          setMeta({ name: meta.name, method: meta.method })

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
        setPlugin(null)
      }
    }
  }, [setPlugin, setChains, setElements, setMeta, setError])

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
