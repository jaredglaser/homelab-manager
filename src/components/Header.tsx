import { Link } from '@tanstack/react-router'
import { Box } from '@mui/joy'
import ModeToggle from './ModeToggle'

export default function Header() {
  return (
    <Box
      component="header"
      sx={{
        p: 0.5,
        display: 'flex',
        gap: 0.5,
        bgcolor: 'background.surface',
        color: 'text.primary',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <nav style={{ display: 'flex', flexDirection: 'row', gap: '0.5rem' }}>
        <Box sx={{ px: 0.5, fontWeight: 'bold' }}>
          <Link to="/">Docker</Link>
        </Box>
        <Box sx={{ px: 0.5, fontWeight: 'bold' }}>
          <Link to="/zfs">ZFS</Link>
        </Box>
      </nav>
      <ModeToggle />
    </Box>
  )
}
