import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import {
  COMPOSE_SAVE_FAILED_MESSAGE,
  DASHBOARD_UNREACHABLE_MESSAGE,
  HOST_NAME_TAKEN_MESSAGE,
  STACK_NAME_TAKEN_MESSAGE,
  UNNAMED_VALUE_REJECTED_MESSAGE,
  serverFailureCopy,
  serverFnErrorMessage,
} from '../server-fn-error-copy';
import { TaggedServerError } from '@/lib/errors/tagged-server-error';

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

describe('serverFailureCopy', () => {
  const labels = { name: 'Host name' };
  let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('names the rejected field by the label the form shows it under', () => {
    const err = new TaggedServerError('invalid_input', 'The value for "name" was not accepted. Check it and try again.', 'name');
    expect(serverFailureCopy(err, { labels, fallback: FALLBACK })).toEqual({
      message: 'The value for "Host name" was not accepted. Check it and try again.',
      field: null,
    });
  });

  it.each([
    ['a field the form has no label for', 'capabilities.docker'],
    ['no field', null],
  ])('words a rejection of %s without naming one', (_label, field) => {
    const err = new TaggedServerError('invalid_input', 'server copy', field);
    expect(serverFailureCopy(err, { labels, fallback: FALLBACK }).message).toBe(UNNAMED_VALUE_REJECTED_MESSAGE);
    expect(UNNAMED_VALUE_REJECTED_MESSAGE).toBe('One of the values was not accepted. Check what you entered and try again.');
  });

  it('puts a taken name under the field the server tagged', () => {
    const err = new TaggedServerError('name_taken', 'A host named "dev-box" already exists. Choose another name.', 'name');
    expect(serverFailureCopy(err, { labels, taken: HOST_NAME_TAKEN_MESSAGE, fallback: FALLBACK })).toEqual({
      message: 'A host with this name already exists. Choose another name.',
      field: 'name',
    });
    expect(STACK_NAME_TAKEN_MESSAGE).toBe('A stack with this name already exists. Choose another name.');
  });

  it('never shows the server text of a taken name when the form has no copy for it', () => {
    const err = new TaggedServerError('name_taken', 'server copy', 'name');
    expect(serverFailureCopy(err, { labels, fallback: FALLBACK })).toEqual({ message: FALLBACK, field: null });
  });

  it('falls back like serverFnErrorMessage for an untagged error', () => {
    expect(serverFailureCopy(new Error('boom'), { labels, fallback: FALLBACK })).toEqual({ message: FALLBACK, field: null });
    expect(serverFailureCopy(new TypeError('Failed to fetch'), { labels, fallback: FALLBACK }).message).toBe(DASHBOARD_UNREACHABLE_MESSAGE);
  });

  it('pins the compose save copy', () => {
    expect(COMPOSE_SAVE_FAILED_MESSAGE).toBe('The compose file could not be saved. Try again.');
  });
});
