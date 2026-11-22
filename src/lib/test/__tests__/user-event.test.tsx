import { describe, expect, it, jest, mock, spyOn } from 'bun:test'
import { useEffect, useState } from 'react'
import { render, screen } from '@testing-library/react'
import { setupUser, activateWithKey } from '@/lib/test/user-event'
import { mockSetTimeout } from '@/lib/test/mock-timers'

function FrameUpdateAfterTimeout({ onFrame }: { onFrame: () => void }) {
  const [open, setOpen] = useState(false)
  const [, setSettled] = useState(false)
  useEffect(() => {
    if (!open) return
    let frame = 0
    const timer = setTimeout(() => {
      frame = requestAnimationFrame(() => {
        setSettled(true)
        onFrame()
      })
    }, 0)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
    }
  }, [open, onFrame])
  return (
    <button type="button" onClick={() => setOpen(true)}>
      Open
    </button>
  )
}

describe('user-event helper', () => {
  it('logs no act warning for a frame update queued behind a timeout', async () => {
    const user = setupUser()
    const errorSpy = spyOn(console, 'error')
    try {
      const { promise: frameRan, resolve } = Promise.withResolvers<void>()
      render(<FrameUpdateAfterTimeout onFrame={resolve} />)
      await user.click(screen.getByRole('button', { name: 'Open' }))
      await frameRan
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('completes user-event calls while the suite captures setTimeout', async () => {
    const timers = mockSetTimeout()
    try {
      const onClick = mock()
      render(<button type="button" onClick={onClick}>Go</button>)
      await setupUser({ timersCaptured: true }).click(screen.getByRole('button', { name: 'Go' }))
      expect(onClick).toHaveBeenCalledTimes(1)
    } finally {
      timers.restore()
    }
  })

  it('completes user-event calls under fake timers', async () => {
    jest.useFakeTimers()
    try {
      const onClick = mock()
      render(<button type="button" onClick={onClick}>Go</button>)
      await activateWithKey(setupUser(), screen.getByRole('button', { name: 'Go' }), '{Enter}')
      expect(onClick).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
