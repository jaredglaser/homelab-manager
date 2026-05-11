import { useState } from 'react'
import Alert from '@mui/material/Alert'
import MuiLink from '@mui/material/Link'

export function DemoBanner() {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-full pt-2 pointer-events-auto w-fit">
      <Alert severity="info" onClose={() => setVisible(false)}>
        <strong>Demo mode</strong> - all data is generated in the browser.
        {' '}Self-host to connect to your own infrastructure.
        {' '}
        <MuiLink href="https://github.com/jaredglaser/homelab-manager/blob/main/self-hosting/README.md" target="_blank" rel="noopener noreferrer">
          Self-host guide
        </MuiLink>
        {' '}&middot;{' '}
        <MuiLink href="https://github.com/jaredglaser/homelab-manager" target="_blank" rel="noopener noreferrer">
          GitHub
        </MuiLink>
      </Alert>
    </div>
  )
}
