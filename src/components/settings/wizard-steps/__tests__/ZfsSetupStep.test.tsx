import { describe, it, expect, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import ZfsSetupStep from '@/components/settings/wizard-steps/ZfsSetupStep'

function renderStep() {
  return render(
    <ZfsSetupStep
      docker={true}
      hlmZfsUid=""
      hlmZfsGid=""
      dockerGid=""
      onHlmZfsUidChange={mock(() => {})}
      onHlmZfsGidChange={mock(() => {})}
      onDockerGidChange={mock(() => {})}
    />,
  )
}

describe('ZfsSetupStep copy button placement', () => {
  it('renders the copy button in a header row above the pre block, not overlapping it', () => {
    renderStep()
    const copyButton = screen.getByLabelText('Copy ZFS setup commands')
    const pre = screen.getByText(/useradd/).closest('pre')
    expect(pre).not.toBeNull()
    expect(copyButton.closest('.absolute')).toBeNull()
    expect(pre?.contains(copyButton)).toBe(false)
  })
})
