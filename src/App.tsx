import { useRef, useEffect, useCallback, useState } from 'react'
import { Layout, Model, TabNode, TabSetNode, Actions, DockLocation, type IJsonModel, type ITabSetRenderValues } from 'flexlayout-react'
import type { BorderNode } from 'flexlayout-react'
import 'flexlayout-react/style/light.css'
import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import ViewInArIcon from '@mui/icons-material/ViewInAr'
import TextSnippetIcon from '@mui/icons-material/TextSnippet'
import ListAltIcon from '@mui/icons-material/ListAlt'
import HubIcon from '@mui/icons-material/Hub'
import FolderIcon from '@mui/icons-material/Folder'
import InfoIcon from '@mui/icons-material/Info'
import { MolstarViewer } from './components/MolstarViewer'
import { SequenceViewer } from './components/SequenceViewer'
import { FileLoader } from './components/FileLoader'
import { StructureLibrary } from './components/StructureLibrary'
import { StructureInfo } from './components/StructureInfo'
import { ElementsTable } from './components/ElementsTable'
import { InteractionsPanel } from './components/InteractionsPanel'
import { useStructureStore } from './stores/structureStore'
import { useSelectionStore } from './stores/selectionStore'
import { useMolstarSync } from './hooks/useMolstarSync'
import { useSequenceSync } from './hooks/useSequenceSync'

const PANEL_TYPES = [
  { component: 'viewer', name: '3D Structure', icon: <ViewInArIcon sx={{ fontSize: 16 }} /> },
  { component: 'sequence', name: 'Sequence', icon: <TextSnippetIcon sx={{ fontSize: 16 }} /> },
  { component: 'elements', name: 'Elements', icon: <ListAltIcon sx={{ fontSize: 16 }} /> },
  { component: 'interactions', name: 'Interactions', icon: <HubIcon sx={{ fontSize: 16 }} /> },
  { component: 'library', name: 'Library', icon: <FolderIcon sx={{ fontSize: 16 }} /> },
  { component: 'info', name: 'Info', icon: <InfoIcon sx={{ fontSize: 16 }} /> },
]

let tabCounter = 0

const layoutJson: IJsonModel = {
  global: {
    tabEnableRename: false,
    tabSetEnableMaximize: true,
    tabSetEnableClose: true,
    splitterSize: 4,
    tabEnableClose: true,
  },
  borders: [],
  layout: {
    type: 'row',
    weight: 100,
    children: [
      {
        type: 'row',
        weight: 22,
        children: [
          {
            type: 'tabset',
            weight: 55,
            children: [
              { type: 'tab', name: 'Library', component: 'library' },
            ],
          },
          {
            type: 'tabset',
            weight: 45,
            children: [
              { type: 'tab', name: 'Info', component: 'info' },
            ],
          },
        ],
      },
      {
        type: 'row',
        weight: 78,
        children: [
          {
            type: 'tabset',
            weight: 65,
            children: [
              { type: 'tab', name: '3D Structure', component: 'viewer' },
            ],
          },
          {
            type: 'row',
            weight: 35,
            children: [
              {
                type: 'tabset',
                weight: 50,
                children: [
                  { type: 'tab', name: 'Sequence', component: 'sequence' },
                ],
              },
              {
                type: 'tabset',
                weight: 50,
                children: [
                  { type: 'tab', name: 'Elements', component: 'elements' },
                  { type: 'tab', name: 'Interactions', component: 'interactions' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
}

function App() { // @dsp obj-a1000002
  const modelRef = useRef(Model.fromJson(layoutJson))
  const plugin = useStructureStore((s) => s.plugin)
  const isLoading = useStructureStore((s) => s.isLoading)
  const error = useStructureStore((s) => s.error)
  const fileName = useStructureStore((s) => s.fileName)
  const clearSelection = useSelectionStore((s) => s.clearSelection)

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [menuTabSetId, setMenuTabSetId] = useState<string | null>(null)

  useMolstarSync()
  useSequenceSync()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearSelection()
        if (plugin) {
          plugin.managers.interactivity.lociSelects.deselectAll()
          plugin.managers.interactivity.lociHighlights.clearHighlights()
          plugin.managers.structure.focus.behaviors.current.next(undefined)
          plugin.managers.structure.focus.clear()
          // Also remove "Show Interface" and sequence-selection sticks
          import('./lib/molstar-helpers').then(m => {
            m.clearInterfaceFocus(plugin).catch(() => {})
            m.clearSelectionSticks(plugin).catch(() => {})
          }).catch(() => {})
          useStructureStore.getState().setFocusedChain(null)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [clearSelection, plugin])

  const factory = useCallback((node: TabNode) => {
    switch (node.getComponent()) {
      case 'viewer': return <MolstarViewer />
      case 'sequence': return <SequenceViewer />
      case 'library': return <StructureLibrary />
      case 'info': return <StructureInfo />
      case 'elements': return <ElementsTable />
      case 'interactions': return <InteractionsPanel />
      default: return null
    }
  }, [])

  const handleAddPanel = useCallback((component: string, name: string) => {
    if (!menuTabSetId) return
    tabCounter++
    modelRef.current.doAction(
      Actions.addNode(
        { type: 'tab', name, component, id: `${component}-${tabCounter}` },
        menuTabSetId,
        DockLocation.CENTER,
        -1,
        true
      )
    )
    setMenuAnchor(null)
    setMenuTabSetId(null)
  }, [menuTabSetId])

  const onRenderTabSet = useCallback((node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    if (node instanceof TabSetNode) {
      renderValues.stickyButtons.push(
        <button
          key="add-tab"
          className="flexlayout__tab_toolbar_button"
          title="Add panel"
          onClick={(e) => {
            setMenuAnchor(e.currentTarget)
            setMenuTabSetId(node.getId())
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 16,
            fontWeight: 300,
            padding: 0,
          }}
        >
          +
        </button>
      )
    }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Toolbar variant="dense" sx={{ minHeight: 36, gap: 2 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', fontSize: '0.7rem', color: '#1D3261' }}>
            Tarantino
          </Typography>
          <Box sx={{ flex: 1 }} />
          {isLoading && <CircularProgress size={14} />}
          {error && <Typography variant="caption" sx={{ color: 'error.main' }}>{error}</Typography>}
          {fileName && (
            <>
              <Typography variant="caption" sx={{ color: '#1D3261', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                {fileName}
              </Typography>
              <Box sx={{ width: '1px', height: 16, bgcolor: '#1D3261', flexShrink: 0 }} />
            </>
          )}
          <FileLoader />
        </Toolbar>
      </AppBar>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <Layout
          model={modelRef.current}
          factory={factory}
          onRenderTabSet={onRenderTabSet}
        />
      </div>

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => { setMenuAnchor(null); setMenuTabSetId(null) }}
        sx={{ '& .MuiPaper-root': { minWidth: 160 } }}
      >
        {PANEL_TYPES.map(pt => (
          <MenuItem key={pt.component} onClick={() => handleAddPanel(pt.component, pt.name)} sx={{ fontSize: '0.75rem', py: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 28 }}>{pt.icon}</ListItemIcon>
            <ListItemText sx={{ '& .MuiTypography-root': { fontSize: '0.75rem' } }}>{pt.name}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </div>
  )
}

export default App
