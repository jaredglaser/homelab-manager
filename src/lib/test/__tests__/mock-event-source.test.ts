import { describe, it, expect, beforeEach } from 'bun:test';
import { MockEventSource } from '../mock-event-source';

describe('MockEventSource', () => {
  beforeEach(() => {
    MockEventSource.reset();
  });

  it('should track instances', () => {
    const es = new MockEventSource('http://localhost/events');
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]).toBe(es);
  });

  it('should store the url', () => {
    const es = new MockEventSource('http://localhost/events');
    expect(es.url).toBe('http://localhost/events');
  });

  it('should start in CONNECTING state', () => {
    const es = new MockEventSource('http://localhost/events');
    expect(es.readyState).toBe(MockEventSource.CONNECTING);
    expect(es.closed).toBe(false);
  });

  it('should close and update readyState', () => {
    const es = new MockEventSource('http://localhost/events');
    es.close();
    expect(es.closed).toBe(true);
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });

  it('should add and fire event listeners', () => {
    const es = new MockEventSource('http://localhost/events');
    let called = false;
    es.addEventListener('message', () => { called = true; });
    es.fireEvent('message');
    expect(called).toBe(true);
  });

  it('should remove event listeners', () => {
    const es = new MockEventSource('http://localhost/events');
    let callCount = 0;
    const handler = () => { callCount++; };
    es.addEventListener('message', handler);
    es.fireEvent('message');
    expect(callCount).toBe(1);

    es.removeEventListener('message', handler);
    es.fireEvent('message');
    expect(callCount).toBe(1);
  });

  it('should reset instances', () => {
    new MockEventSource('http://localhost/events');
    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.reset();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('should have correct static constants', () => {
    expect(MockEventSource.CONNECTING).toBe(0);
    expect(MockEventSource.OPEN).toBe(1);
    expect(MockEventSource.CLOSED).toBe(2);
  });
});
