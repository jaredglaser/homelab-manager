import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { DASHBOARD_UNREACHABLE_MESSAGE, serverFnErrorMessage } from '../server-fn-error-copy';

const FALLBACK = 'Fallback copy for the caller.';

describe('serverFnErrorMessage', () => {
  let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('pins the unreachable copy', () => {
    expect(DASHBOARD_UNREACHABLE_MESSAGE).toBe("Couldn't reach the dashboard. Check your connection and try again.");
  });

  it.each([
    ['Chrome', 'Failed to fetch'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ['Safari', 'Load failed'],
  ])('maps the %s fetch failure to the unreachable copy', (_browser, text) => {
    expect(serverFnErrorMessage(new TypeError(text), FALLBACK)).toBe(DASHBOARD_UNREACHABLE_MESSAGE);
  });

  it.each([
    ['a permission denial', new Error('Insufficient permissions')],
    ['an expired session', new Error('Unauthorized')],
    ['a missing host', new Error('Host with id 12 not found')],
    ['an Error whose name claims TypeError', Object.assign(new Error('x'), { name: 'TypeError' })],
    ['a string', 'raw string'],
    ['undefined', undefined],
  ])('returns the fallback for %s', (_label, err) => {
    expect(serverFnErrorMessage(err, FALLBACK)).toBe(FALLBACK);
  });

  it('logs the original error exactly once', () => {
    const err = new Error('Host with id 12 not found');
    serverFnErrorMessage(err, FALLBACK);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe(err);
  });
});
