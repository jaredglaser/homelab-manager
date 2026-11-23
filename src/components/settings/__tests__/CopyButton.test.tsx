import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test'
import { render, screen, act } from '@testing-library/react'
import '@/lib/test/testing-library'
import CopyButton from '@/components/settings/CopyButton'
import { COPY_FEEDBACK_MS } from '@/lib/constants/ui-timing'
import { setupUser, activateWithKey } from '@/lib/test/user-event'

describe('CopyButton', () => {
  let writeTextMock: ReturnType<typeof mock>

  beforeEach(() => {
    writeTextMock = mock(() => Promise.resolve())
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('renders copy icon initially', () => {
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    expect(button.querySelector('.lucide-copy')).not.toBeNull()
    expect(button.querySelector('.lucide-check')).toBeNull()
  })

  it('shows tooltip with copy label initially', () => {
    render(<CopyButton text="hello" label="token" />)
    expect(screen.getByLabelText('Copy token')).toBeDefined()
  })

  it('calls navigator.clipboard.writeText with the text prop when clicked', async () => {
    const user = setupUser()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })
    render(<CopyButton text="my-secret-token" label="token" />)
    const button = screen.getByLabelText('Copy token')
    await user.click(button)
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith('my-secret-token')
  })

  it.each(['{Enter}', ' '] as const)('copies when activated from the keyboard with %j', async (key) => {
    const user = setupUser()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })
    render(<CopyButton text="my-secret-token" label="token" />)
    await activateWithKey(user, screen.getByLabelText('Copy token'), key)
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith('my-secret-token')
  })

  it('shows the check icon until the feedback delay has passed, then reverts to the copy icon', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    await user.click(button)
    expect(button.querySelector('.lucide-check')).not.toBeNull()

    act(() => {
      jest.advanceTimersByTime(COPY_FEEDBACK_MS - 50)
    })
    expect(button.querySelector('.lucide-check')).not.toBeNull()

    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(button.querySelector('.lucide-check')).toBeNull()
    expect(button.querySelector('.lucide-copy')).not.toBeNull()
  })

  it('still gives copied feedback on insecure origins where navigator.clipboard is undefined', async () => {
    const user = setupUser()
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    const execCommandMock = mock(() => true)
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      writable: true,
      configurable: true,
    })

    render(<CopyButton text="insecure" label="token" />)
    const button = screen.getByLabelText('Copy token')
    await user.click(button)

    expect(execCommandMock).toHaveBeenCalledWith('copy')
    expect(button.querySelector('.lucide-check')).not.toBeNull()

    delete (document as { execCommand?: unknown }).execCommand
  })

  it('does not throw when clipboard.writeText resolves', async () => {
    writeTextMock = mock(() => Promise.resolve())
    const user = setupUser()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })
    render(<CopyButton text="test" label="test label" />)
    await user.click(screen.getByLabelText('Copy test label'))
    expect(writeTextMock).toHaveBeenCalledTimes(1)
  })
})
