import { useState } from 'react'
import { IconButton, Tooltip } from '@mui/material'
import { Copy, Check } from 'lucide-react'

export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
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
