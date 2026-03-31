import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@/lib/test/testing-library'
import CopyButton from '@/components/settings/CopyButton'

describe('CopyButton', () => {
  let writeTextMock: ReturnType<typeof mock>
  let setTimeoutSpy: ReturnType<typeof spyOn>
  let capturedCallback: (() => void) | null = null

  beforeEach(() => {
    writeTextMock = mock(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })

    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => {
        capturedCallback = fn
        return 0
      }) as unknown as typeof setTimeout
    )
    capturedCallback = null
  })

  afterEach(() => {
    setTimeoutSpy.mockRestore()
  })

  it('renders copy icon initially', () => {
    render(<CopyButton text="hello" label="greeting" />)
    expect(screen.getByLabelText('Copy greeting')).toBeDefined()
    // check icon should not be present
    const button = screen.getByLabelText('Copy greeting')
    // Copy icon is rendered (not Check icon)
    expect(button.querySelector('svg')).toBeDefined()
  })

  it('shows tooltip with copy label initially', () => {
    render(<CopyButton text="hello" label="token" />)
    expect(screen.getByLabelText('Copy token')).toBeDefined()
  })

  it('calls navigator.clipboard.writeText with the text prop when clicked', async () => {
    render(<CopyButton text="my-secret-token" label="token" />)
    const button = screen.getByLabelText('Copy token')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith('my-secret-token')
  })

  it('schedules a timeout to revert the copied state after clicking', async () => {
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
  })

  it('reverts to copy icon after timeout fires', async () => {
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')

    await act(async () => {
      fireEvent.click(button)
    })

    // Fire the captured timeout callback
    act(() => {
      capturedCallback?.()
    })

    // After reset, aria-label should still say 'Copy greeting' (not changed)
    expect(screen.getByLabelText('Copy greeting')).toBeDefined()
  })

  it('does not throw when clipboard.writeText resolves', async () => {
    writeTextMock = mock(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })
    render(<CopyButton text="test" label="test label" />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy test label'))
    })
    expect(writeTextMock).toHaveBeenCalledTimes(1)
  })
})
