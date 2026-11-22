import { expect, jest } from 'bun:test'
import { act } from '@testing-library/react'
import { configure, getConfig } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'

export type TestUser = ReturnType<typeof userEvent.setup>

type ActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const realSetTimeout = globalThis.setTimeout
const rtlConfig = getConfig()

// RTL's drain looks up setTimeout at call time (hangs under a suite's replacement) and returns before Base UI's rAF transition updates run (setImmediate in Happy-DOM), so they land outside act.
configure({
  asyncWrapper: async (cb) => {
    // Fake timers also capture realSetTimeout and the rAF's setImmediate, so neither drain would fire.
    if (jest.isFakeTimers()) return (await rtlConfig.asyncWrapper(cb)) as unknown
    const env = globalThis as ActEnvironmentGlobal
    const previous = env.IS_REACT_ACT_ENVIRONMENT
    env.IS_REACT_ACT_ENVIRONMENT = false
    try {
      const result: unknown = await cb()
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return result
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous
    }
  },
})

interface SetupUserOptions {
  /** Set when the suite replaces or spies on globalThis.setTimeout: hover schedules tooltip delay timers that join the capture and inflate spy call counts. */
  timersCaptured?: boolean
}

/** One instance per test: user-event keeps pointer and keyboard state. `delay: null` skips the setTimeout(0) user-event awaits around every action, which hangs under a captured setTimeout. */
export function setupUser({ timersCaptured = false }: SetupUserOptions = {}): TestUser {
  return userEvent.setup({ delay: null, skipHover: timersCaptured })
}

/** user.click fires the whole pointer and mouse sequence, so it cannot tell onClick from onMouseDown. Enter and Space only synthesize a click. */
export async function activateWithKey(user: TestUser, element: HTMLElement, key: '{Enter}' | ' ') {
  act(() => element.focus())
  expect(document.activeElement).toBe(element)
  await user.keyboard(key)
}
