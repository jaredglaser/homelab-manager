import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test'
import { render, screen, act } from '@testing-library/react'
import '@/lib/test/testing-library'
import CopyButton from '@/components/settings/CopyButton'
import { COPY_FEEDBACK_MS } from '@/lib/constants/ui-timing'
import { setupUser, activateWithKey, type TestUser } from '@/lib/test/user-event'

describe('CopyButton', () => {
  let writeTextMock: ReturnType<typeof mock>

  const tooltipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent

  // The tooltip opens on keyboard focus and closes on press, so tab away and back to read it after a click.
  async function reopenTooltip(user: TestUser) {
    await user.tab()
    await user.tab()
  }

  function advance(ms: number) {
    act(() => {
      jest.advanceTimersByTime(ms)
    })
  }

  function setupUserWithClipboard(clipboard: unknown) {
    const user = setupUser()
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, writable: true, configurable: true })
    return user
  }

  beforeEach(() => {
    writeTextMock = mock(() => Promise.resolve())
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('renders the copy icon, not the check icon, before anything is copied', () => {
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    expect(button.querySelector('.lucide-copy')).not.toBeNull()
    expect(button.querySelectorAll('.lucide-check').length).toBe(0)
  })

  it('shows the Copy label tooltip before anything is copied', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="token" />)
    await user.tab()
    expect(tooltipText()).toBe('Copy token')
  })

  it('calls navigator.clipboard.writeText with the text prop when clicked', async () => {
    const user = setupUserWithClipboard({ writeText: writeTextMock })
    render(<CopyButton text="my-secret-token" label="token" />)
    await user.click(screen.getByLabelText('Copy token'))
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith('my-secret-token')
  })

  it.each(['{Enter}', ' '] as const)('copies when activated from the keyboard with %j', async (key) => {
    const user = setupUserWithClipboard({ writeText: writeTextMock })
    render(<CopyButton text="my-secret-token" label="token" />)
    await activateWithKey(user, screen.getByLabelText('Copy token'), key)
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith('my-secret-token')
  })

  it('switches to the check icon and a Copied! tooltip after clicking', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    await user.click(button)
    expect(button.querySelector('.lucide-check')).not.toBeNull()
    expect(button.querySelectorAll('.lucide-copy').length).toBe(0)
    await reopenTooltip(user)
    expect(tooltipText()).toBe('Copied!')
  })

  it('shows the check icon until the feedback delay has passed, then reverts to the copy icon and the Copy label tooltip', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    await user.click(button)
    expect(button.querySelector('.lucide-check')).not.toBeNull()

    advance(COPY_FEEDBACK_MS - 50)
    expect(button.querySelector('.lucide-check')).not.toBeNull()

    advance(100)
    expect(button.querySelector('.lucide-copy')).not.toBeNull()
    expect(button.querySelectorAll('.lucide-check').length).toBe(0)
    await reopenTooltip(user)
    expect(tooltipText()).toBe('Copy greeting')
  })

  describe('on insecure origins where navigator.clipboard is undefined', () => {
    let copiedValues: string[]

    beforeEach(() => {
      copiedValues = []
      Object.defineProperty(document, 'execCommand', {
        value: mock((command: string) => {
          copiedValues.push(`${command}:${document.querySelector('textarea')?.value}`)
          return true
        }),
        writable: true,
        configurable: true,
      })
    })

    afterEach(() => {
      delete (document as { execCommand?: unknown }).execCommand
    })

    it('copies the text through a temporary textarea and removes it afterwards', async () => {
      const user = setupUserWithClipboard(undefined)
      render(<CopyButton text="insecure-token" label="token" />)
      await user.click(screen.getByLabelText('Copy token'))
      expect(copiedValues).toEqual(['copy:insecure-token'])
      expect(document.querySelectorAll('textarea').length).toBe(0)
    })

    it('still gives copied feedback and reverts it', async () => {
      const user = setupUserWithClipboard(undefined)
      render(<CopyButton text="insecure" label="token" />)
      const button = screen.getByLabelText('Copy token')
      await user.click(button)
      expect(button.querySelector('.lucide-check')).not.toBeNull()

      advance(COPY_FEEDBACK_MS + 50)

      expect(button.querySelector('.lucide-copy')).not.toBeNull()
    })
  })
})
