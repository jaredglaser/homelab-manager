import { expect } from 'bun:test'
import { act, configure } from '@testing-library/react'
import { getConfig } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'

export type TestUser = ReturnType<typeof userEvent.setup>

interface SetupUserOptions {
  /** Set when the suite replaces or spies on globalThis.setTimeout: user-event's hover timers would be captured, never fire, and inflate spy call counts. */
  timersCaptured?: boolean
}

/** One instance per test: user-event keeps pointer and keyboard state. `delay: null` drops the setTimeout(0) it otherwise awaits after every keystroke. */
export function setupUser({ timersCaptured = false }: SetupUserOptions = {}): TestUser {
  return userEvent.setup({ delay: null, skipHover: timersCaptured })
}

/** RTL's default asyncWrapper drains microtasks through setTimeout, so under a replaced setTimeout every awaited user-event call hangs. */
export function installPassthroughAsyncWrapper(): () => void {
  const previous = { ...getConfig() }
  configure({ asyncWrapper: (cb: () => unknown) => Promise.resolve(cb()) })
  return () => configure(previous)
}

/** user.click fires the whole pointer and mouse sequence, so it cannot tell onClick from onMouseDown. Enter and Space only synthesize a click. */
export async function activateWithKey(user: TestUser, element: HTMLElement, key: '{Enter}' | ' ') {
  act(() => element.focus())
  expect(document.activeElement).toBe(element)
  await user.keyboard(key)
}
