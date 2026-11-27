import { useState } from 'react'
import { X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

const LINK_CLASSES = 'text-info underline underline-offset-2 hover:opacity-80'

export function DemoBanner() {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-full pt-2 pointer-events-auto w-fit max-w-[calc(100vw-1rem)]">
      <Alert variant="info" className="pr-2">
        <AlertDescription className="grid-flow-col items-center">
          <span>
            <strong>Demo mode</strong> - all data is generated in the browser.
            {' '}Self-host to connect to your own infrastructure.
            {' '}
            <a
              href="https://github.com/jaredglaser/homelab-manager/blob/main/self-hosting/README.md"
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASSES}
            >
              Self-host guide
            </a>
            {' '}&middot;{' '}
            <a
              href="https://github.com/jaredglaser/homelab-manager"
              target="_blank"
              rel="noopener noreferrer"
              className={LINK_CLASSES}
            >
              GitHub
            </a>
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-info ml-2"
            aria-label="Close"
            onClick={() => setVisible(false)}
          >
            <X size={16} />
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}
