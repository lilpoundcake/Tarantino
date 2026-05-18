import { useCallback, useRef } from 'react'
import Button from '@mui/material/Button'

import UploadFileIcon from '@mui/icons-material/UploadFile'
import { useStructureStore } from '../stores/structureStore'
import { useSelectionStore } from '../stores/selectionStore'

function detectFormat(filename: string): 'pdb' | 'mmcif' {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.cif') || lower.endsWith('.mmcif')) return 'mmcif'
  return 'pdb'
}

export function FileLoader() { // @dsp obj-a1000005
  const inputRef = useRef<HTMLInputElement>(null)
  const plugin = useStructureStore((s) => s.plugin)
  const secondaryPlugin = useStructureStore((s) => s.secondaryPlugin)
  const loadTargetSlot = useStructureStore((s) => s.loadTargetSlot)
  const setFileName = useStructureStore((s) => s.setFileName)
  const setSecondaryFileName = useStructureStore((s) => s.setSecondaryFileName)
  const setLoading = useStructureStore((s) => s.setLoading)
  const setError = useStructureStore((s) => s.setError)
  const clearSelection = useSelectionStore((s) => s.clearSelection)

  const loadFile = useCallback(async (file: File) => {
    const targetPlugin = loadTargetSlot === 'secondary' ? secondaryPlugin : plugin
    if (!targetPlugin) {
      setError(
        loadTargetSlot === 'secondary'
          ? 'Open a "3D Structure (B)" tab first'
          : 'Viewer not initialized yet'
      )
      return
    }

    setLoading(true)
    setError(null)
    if (loadTargetSlot === 'primary') clearSelection()

    try {
      const text = await file.text()
      const format = detectFormat(file.name)

      await targetPlugin.clear()
      const data = await targetPlugin.builders.data.rawData({ data: text, label: file.name })
      const trajectory = await targetPlugin.builders.structure.parseTrajectory(data, format)
      await targetPlugin.builders.structure.hierarchy.applyPreset(trajectory, 'default')

      if (loadTargetSlot === 'secondary') {
        setSecondaryFileName(file.name)
      } else {
        setFileName(file.name)
      }
    } catch (err: any) {
      setError(`Failed to load file: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [plugin, secondaryPlugin, loadTargetSlot, setFileName, setSecondaryFileName, setLoading, setError, clearSelection])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) loadFile(file)
    if (inputRef.current) inputRef.current.value = ''
  }, [loadFile])

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<UploadFileIcon sx={{ fontSize: 14 }} />}
        onClick={() => inputRef.current?.click()}
        sx={{ fontSize: '0.7rem', py: 0.25, px: 1 }}
      >
        Upload {secondaryPlugin ? `→ ${loadTargetSlot === 'secondary' ? 'B' : 'A'}` : ''}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdb,.cif,.mmcif"
        onChange={handleFileInput}
        style={{ display: 'none' }}
      />
    </>
  )
}
