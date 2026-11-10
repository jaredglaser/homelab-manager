import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { render, screen, act, configure } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/lib/test/testing-library'
import CopyButton from '@/components/settings/CopyButton'
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers'

// RTL's asyncWrapper drains microtasks via setTimeout and then calls jest.advanceTimersByTime, which bun's timer spy makes look like fake timers: the drain hangs under mockSetTimeout and the advance call throws.
configure({ asyncWrapper: (cb: () => unknown) => Promise.resolve(cb()) })

// delay: null skips user-event's internal wait timer, which mockSetTimeout would capture and never fire, and skipHover keeps tooltip hover timers out of setSpy call counts.
function setupUser() {
  return userEvent.setup({ delay: null, skipHover: true })
}

describe('CopyButton', () => {
  let writeTextMock: ReturnType<typeof mock>
  let timers: TimerMock

  beforeEach(() => {
    writeTextMock = mock(() => Promise.resolve())
    timers = mockSetTimeout()
  })

  afterEach(() => {
    timers.restore()
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
    const user = setupUser()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })
    render(<CopyButton text="my-secret-token" label="token" />)
    const button = screen.getByLabelText('Copy token')
    await act(async () => {
      await user.click(button)
    })
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith('my-secret-token')
  })

  it('schedules a timeout to revert the copied state after clicking', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')
    await act(async () => {
      await user.click(button)
    })
    expect(timers.setSpy).toHaveBeenCalledTimes(1)
  })

  it('reverts to copy icon after timeout fires', async () => {
    const user = setupUser()
    render(<CopyButton text="hello" label="greeting" />)
    const button = screen.getByLabelText('Copy greeting')

    await act(async () => {
      await user.click(button)
    })

    act(() => {
      timers.fireNext()
    })

    // After reset, aria-label should still say 'Copy greeting' (not changed)
    expect(screen.getByLabelText('Copy greeting')).toBeDefined()
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
    await act(async () => {
      await user.click(button)
    })

    expect(execCommandMock).toHaveBeenCalledWith('copy')
    // Optimistic feedback: the check icon (with its enter animation) renders
    // immediately without waiting on a clipboard promise.
    expect(button.querySelector('.lucide-check')).toBeDefined()

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
    await act(async () => {
      await user.click(screen.getByLabelText('Copy test label'))
    })
    expect(writeTextMock).toHaveBeenCalledTimes(1)
  })
})
