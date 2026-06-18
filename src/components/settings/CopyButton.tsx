import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-foreground"
            onClick={handleCopy}
            aria-label={`Copy ${label}`}
          />
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied!' : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  )
}
