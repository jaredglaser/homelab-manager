import { expect, jest } from 'bun:test'
import { act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

export type TestUser = ReturnType<typeof userEvent.setup>

/** One instance per test: user-event keeps pointer and keyboard state and replaces navigator.clipboard, so install a clipboard mock after this call. Under fake timers its wait between actions advances the fake clock instead of hanging. */
export function setupUser(): TestUser {
  return userEvent.setup({
    advanceTimers: (ms) => {
      if (jest.isFakeTimers()) jest.advanceTimersByTime(ms)
    },
  })
}

/** user.click fires the whole pointer and mouse sequence, so it cannot tell onClick from onMouseDown. Enter and Space fire click with no pointer or mouse events. */
export async function activateWithKey(user: TestUser, element: HTMLElement, key: '{Enter}' | ' ') {
  const dialog = element.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  // An opening dialog focuses its initial element on the next animation frame, which would take focus from the target after the check below passes.
  if (dialog) {
    await waitFor(() => {
      if (!dialog.contains(document.activeElement)) throw new Error('activateWithKey: focus never moved into the enclosing dialog')
    })
  }
  act(() => element.focus())
  expect(document.activeElement).toBe(element)
  await user.keyboard(key)
}
