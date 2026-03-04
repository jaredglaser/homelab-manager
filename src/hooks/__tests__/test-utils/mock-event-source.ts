export class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  readyState = 0;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter(h => h !== handler));
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  fireEvent(type: string) {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) handler({});
  }

  static reset() {
    MockEventSource.instances = [];
  }
}
