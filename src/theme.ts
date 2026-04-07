import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#4a76c4' },
    secondary: { main: '#7c5cbf' },
    background: {
      default: '#e8ecf1',
      paper: '#f0f3f7',
    },
    divider: '#c9d1dc',
    text: {
      primary: '#1a1a2e',
      secondary: '#5a607a',
    },
    error: { main: '#c62828' },
    warning: { main: '#e68a00' },
    success: { main: '#2e7d32' },
    info: { main: '#1976d2' },
    action: {
      hover: 'rgba(74, 118, 196, 0.06)',
      selected: 'rgba(74, 118, 196, 0.12)',
    },
  },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: 12,
  },
  shape: { borderRadius: 6 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        'html, body, #root': {
          height: '100%',
          width: '100%',
          overflow: 'hidden',
        },
      },
    },
    MuiButton: {
      defaultProps: { size: 'small', disableElevation: true },
      styleOverrides: {
        root: { textTransform: 'none', fontSize: '0.75rem' },
      },
    },
    MuiIconButton: {
      defaultProps: { size: 'small' },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { fontSize: '0.75rem', padding: '6px 12px', borderColor: '#c9d1dc' },
        head: { fontWeight: 600, color: '#5a607a', backgroundColor: '#e8ecf1' },
      },
    },
    MuiTextField: {
      defaultProps: { size: 'small', variant: 'outlined' },
      styleOverrides: {
        root: { '& .MuiInputBase-input': { fontSize: '0.75rem' } },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { height: 20, fontSize: '0.65rem' },
      },
    },
    MuiTooltip: {
      defaultProps: { arrow: true },
      styleOverrides: {
        tooltip: { fontSize: '0.7rem' },
      },
    },
  },
})
