import { useState } from 'react'
import { IconButton, Tooltip } from '@mui/material'
import { Copy, Check } from 'lucide-react'
import { COPY_FEEDBACK_MS } from '@/lib/constants/ui-timing'

export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    })
  }

  return (
    <Tooltip title={copied ? 'Copied!' : `Copy ${label}`}>
      <IconButton size="small" onClick={handleCopy} aria-label={`Copy ${label}`}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
    </Tooltip>
  )
}
