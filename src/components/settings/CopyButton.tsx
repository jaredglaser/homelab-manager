import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COPY_FEEDBACK_MS } from '@/lib/constants/ui-timing'

export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    // Optimistic feedback: the copied state must flip even when the Clipboard
    // API is unavailable (insecure origins like http://<lan-ip> have no
    // navigator.clipboard), otherwise the button looks dead.
    setCopied(true)
    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)

    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
      return
    }
    // Fallback for insecure origins where navigator.clipboard is undefined.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={`transition-colors duration-150 ${copied ? 'text-primary' : 'text-foreground'}`}
            onClick={handleCopy}
            aria-label={`Copy ${label}`}
          />
        }
      >
        {copied
          ? <Check size={14} className="animate-in zoom-in-50 duration-200" />
          : <Copy size={14} className="animate-in fade-in duration-200" />}
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied!' : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  )
}
