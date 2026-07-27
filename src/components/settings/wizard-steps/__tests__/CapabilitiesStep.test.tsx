import { describe, it, expect, mock } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import CapabilitiesStep from '@/components/settings/wizard-steps/CapabilitiesStep'

function renderStep(overrides?: Partial<{ docker: boolean; zfs: boolean }>) {
  const onDockerChange = mock((_value: boolean) => {})
  const onZfsChange = mock((_value: boolean) => {})
  render(
    <CapabilitiesStep
      name=""
      docker={overrides?.docker ?? true}
      zfs={overrides?.zfs ?? false}
      onNameChange={mock(() => {})}
      onDockerChange={onDockerChange}
      onZfsChange={onZfsChange}
    />,
  )
  return { onDockerChange, onZfsChange }
}

describe('CapabilitiesStep checkbox rows', () => {
  it('toggles Docker once when the label text is clicked, not the checkbox itself', () => {
    const { onDockerChange } = renderStep({ docker: true })
    fireEvent.click(screen.getByText('Docker'))
    expect(onDockerChange).toHaveBeenCalledTimes(1)
    expect(onDockerChange.mock.calls[0]?.[0]).toBe(false)
  })

  it('toggles ZFS once when the checkbox itself is clicked', () => {
    const { onZfsChange } = renderStep({ zfs: false })
    fireEvent.click(screen.getByLabelText('ZFS capability'))
    expect(onZfsChange).toHaveBeenCalledTimes(1)
    expect(onZfsChange.mock.calls[0]?.[0]).toBe(true)
  })
})
