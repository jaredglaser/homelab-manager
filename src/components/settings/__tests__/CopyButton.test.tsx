import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { render, screen, act, configure } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/lib/test/testing-library'
import CopyButton from '@/components/settings/CopyButton'
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers'
import { COPY_FEEDBACK_MS } from '@/lib/constants/ui-timing'

// RTL's asyncWrapper drains microtasks via setTimeout and then calls jest.advanceTimersByTime, which bun's timer spy makes look like fake timers: the drain hangs under mockSetTimeout and the advance call throws.
configure({ asyncWrapper: (cb: () => unknown) => Promise.resolve(cb()) })

// delay: null skips user-event's internal wait timer, which mockSetTimeout would capture and never fire, and skipHover keeps tooltip hover timers out of setSpy call counts.
function setupUser() {
  return userEvent.setup({ delay: null, skipHover: true })
}

describe('CopyButton', () => {
  let writeTextMock: ReturnType<typeof mock>
  let timers: TimerMock

  const tooltipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent

  // The tooltip opens on keyboard focus and closes on press, so tab away and back to read it after a click.
  async function reopenTooltip(user: ReturnType<typeof setupUser>) {
    await act(async () => {
      await user.tab()
      await user.tab()
    })
  }

  function revertCopiedState() {
    const timer = timers.scheduled.find((t) => t.delayMs === COPY_FEEDBACK_MS && !t.fired)
    expect(timer).toBeDefined()
    act(() => {
      void timers.fire(timer!)
    })
  }

  // user-event installs its own clipboard stub in setup(), so the clipboard under test goes in after it.
  function setupUserWithClipboard(clipboard: unknown) {
    const user = setupUser()
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, writable: true, configurable: true })
    return user
  }

  beforeEach(() => {
    writeTextMock = mock(() => Promise.resolve())
    timers = mockSetTimeout()
  })

  afterEach(() => {
    timers.restore()
  })

  it('renders the copy icon, not the check icon, before anything is copied', () => {
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    expect(button.querySelector('.lucide-copy')).not.toBeNull()
    expect(button.querySelector('.lucide-check')).toBeNull()
  })

  it('shows the Copy label tooltip before anything is copied', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="token" />)
    await act(async () => {
      await user.tab()
    })
    expect(tooltipText()).toBe('Copy token')
  })

  it('calls navigator.clipboard.writeText with the text prop when clicked', async () => {
    const user = setupUserWithClipboard({ writeText: writeTextMock })
    render(<CopyButton text="my-secret-token" label="token" />)
    await act(async () => {
      await user.click(screen.getByLabelText('Copy token'))
    })
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith('my-secret-token')
  })

  it('switches to the check icon and a Copied! tooltip after clicking', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    await act(async () => {
      await user.click(button)
    })
    expect(button.querySelector('.lucide-check')).not.toBeNull()
    expect(button.querySelector('.lucide-copy')).toBeNull()
    await reopenTooltip(user)
    expect(tooltipText()).toBe('Copied!')
  })

  it('schedules the revert after the copy feedback delay', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    await act(async () => {
      await user.click(screen.getByLabelText('Copy greeting'))
    })
    expect(timers.delays).toContain(COPY_FEEDBACK_MS)
  })

  it('reverts to the copy icon and the Copy label tooltip when the timeout fires', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    await act(async () => {
      await user.click(button)
    })
    expect(button.querySelector('.lucide-check')).not.toBeNull()

    revertCopiedState()

    expect(button.querySelector('.lucide-copy')).not.toBeNull()
    expect(button.querySelector('.lucide-check')).toBeNull()
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
      await act(async () => {
        await user.click(screen.getByLabelText('Copy token'))
      })
      expect(copiedValues).toEqual(['copy:insecure-token'])
      expect(document.querySelector('textarea')).toBeNull()
    })

    it('still gives copied feedback and reverts it', async () => {
      const user = setupUserWithClipboard(undefined)
      render(<CopyButton text="insecure" label="token" />)
      const button = screen.getByLabelText('Copy token')
      await act(async () => {
        await user.click(button)
      })
      expect(button.querySelector('.lucide-check')).not.toBeNull()

      revertCopiedState()

      expect(button.querySelector('.lucide-copy')).not.toBeNull()
    })
  })
})
