const RUNBOOK_URL = 'https://github.com/jaredglaser/homelab-manager/blob/main/self-hosting/README.md'
const LINK_CLASSES = 'text-info underline underline-offset-2 hover:opacity-80'

/**
 * Links to a section of the self-hosting guide. Unlike the demo banner's links this renders
 * whatever the mode, because a recovery step is exactly what an operator needs mid-failure.
 */
export function DocLink({ anchor, children }: { anchor: string; children: React.ReactNode }) {
  return (
    <a
      href={`${RUNBOOK_URL}#${anchor}`}
      target="_blank"
      rel="noopener noreferrer"
      className={LINK_CLASSES}
    >
      {children}
    </a>
  )
}
