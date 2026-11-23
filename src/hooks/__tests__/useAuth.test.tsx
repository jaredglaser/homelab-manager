import { describe, it, expect, mock, beforeEach, spyOn, beforeAll, afterAll } from 'bun:test';
import { act, render, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import '@/lib/test/testing-library';
import { mockModule } from '@/lib/test/mock-module';
import { clearSession } from '@/lib/test/session';
import { queryClient } from '@/lib/query-client';
import { SYNTHETIC_ADMIN, type AuthUser } from '@/lib/auth/types';
import type * as AuthFunctions from '@/data/auth.functions';
import type * as Router from '@tanstack/react-router';

let sessionResult: () => Promise<AuthUser | null> = () => Promise.resolve(null);
const mockGetSession = mock(() => sessionResult());
mockModule<typeof AuthFunctions>('@/data/auth.functions', (real) => ({
  ...real,
  getSession: mockGetSession,
}));

const mockNavigate = mock(() => Promise.resolve());
mockModule<typeof Router>('@tanstack/react-router', (real) => ({
  ...real,
  useNavigate: () => mockNavigate,
}));

const { useAuth, useCanWrite } = await import('@/hooks/useAuth');

const viewer: AuthUser = { id: 3, email: 'viewer@example.com', name: 'Viewer', role: 'viewer' };
const admin: AuthUser = { id: 4, email: 'admin@example.com', name: 'Admin', role: 'admin' };

function Probe({ id }: { id: number }) {
  const { user, loading, authEnabled } = useAuth();
  const canWrite = useCanWrite();
  return (
    <span data-testid={`probe-${id}`}>
      {loading ? 'loading' : `${user?.role ?? 'none'}|${String(authEnabled)}|${String(canWrite)}`}
    </span>
  );
}

function CanWriteProbe() {
  return <span data-testid="can-write">{String(useCanWrite())}</span>;
}

function pastStaleTime() {
  const later = Date.now() + 60_000;
  return spyOn(Date, 'now').mockImplementation(() => later);
}

function refocusWindow() {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

function Page() {
  return (
    <>
      {[1, 2, 3, 4, 5, 6].map((id) => <Probe key={id} id={id} />)}
    </>
  );
}

async function settled(): Promise<string> {
  await waitFor(() => expect(screen.getByTestId('probe-1').textContent).not.toBe('loading'));
  return screen.getByTestId('probe-1').textContent;
}

describe('useAuth shared session', () => {
  // The app mounts this client through the QueryClientProvider in __root.tsx, which is what subscribes it to window focus.
  beforeAll(() => {
    queryClient.mount();
  });

  afterAll(() => {
    queryClient.unmount();
  });

  beforeEach(() => {
    clearSession();
    mockGetSession.mockClear();
    mockNavigate.mockClear();
  });

  it('sends one getSession for a page whose components ask many times', async () => {
    sessionResult = () => Promise.resolve(viewer);
    render(<Page />);
    expect(await settled()).toBe('viewer|true|false');
    for (const id of [2, 3, 4, 5, 6]) expect(screen.getByTestId(`probe-${id}`).textContent).toBe('viewer|true|false');
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('refetches on the next page mount, so a session that expired since redirects to /login', async () => {
    sessionResult = () => Promise.resolve(admin);
    const first = render(<Page />);
    expect(await settled()).toBe('admin|true|true');
    first.unmount();
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    sessionResult = () => Promise.resolve(null);
    const later = Date.now() + 60_000;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => later);
    try {
      render(<Page />);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' }));
      expect(screen.getByTestId('probe-1').textContent).toBe('none|true|false');
      expect(mockGetSession).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('picks up a changed role on the next page mount', async () => {
    sessionResult = () => Promise.resolve(admin);
    const first = render(<Probe id={1} />);
    expect(await settled()).toBe('admin|true|true');
    first.unmount();

    sessionResult = () => Promise.resolve(viewer);
    const later = Date.now() + 60_000;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => later);
    try {
      render(<Probe id={1} />);
      await waitFor(() => expect(screen.getByTestId('probe-1').textContent).toBe('viewer|true|false'));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('refetches for a page that only asks useCanWrite, so a session that expired since redirects to /login', async () => {
    sessionResult = () => Promise.resolve(admin);
    const first = render(<CanWriteProbe />);
    await waitFor(() => expect(screen.getByTestId('can-write').textContent).toBe('true'));
    first.unmount();

    sessionResult = () => Promise.resolve(null);
    const nowSpy = pastStaleTime();
    try {
      render(<CanWriteProbe />);
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' }));
      expect(screen.getByTestId('can-write').textContent).toBe('false');
      expect(mockGetSession).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('picks up a changed role when the window regains focus', async () => {
    sessionResult = () => Promise.resolve(admin);
    render(<Probe id={1} />);
    expect(await settled()).toBe('admin|true|true');

    sessionResult = () => Promise.resolve(viewer);
    const nowSpy = pastStaleTime();
    try {
      refocusWindow();
      await waitFor(() => expect(screen.getByTestId('probe-1').textContent).toBe('viewer|true|false'));
      expect(mockGetSession).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      focusManager.setFocused(undefined);
    }
  });

  it('keeps the signed-in session and stays put when a focus refetch fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    sessionResult = () => Promise.resolve(admin);
    render(<Probe id={1} />);
    expect(await settled()).toBe('admin|true|true');

    sessionResult = () => Promise.reject(new Error('server restarting'));
    const nowSpy = pastStaleTime();
    try {
      refocusWindow();
      await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
      expect(mockGetSession).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('probe-1').textContent).toBe('admin|true|true');
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      errorSpy.mockRestore();
      focusManager.setFocused(undefined);
    }
  });

  it('sends one getSession when a page mounts right after the first check for the app shell lands', async () => {
    sessionResult = () => Promise.resolve(admin);
    render(<Probe id={1} />);
    expect(await settled()).toBe('admin|true|true');

    render(<CanWriteProbe />);
    expect(screen.getByTestId('can-write').textContent).toBe('true');
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('redirects to /login when there is no session', async () => {
    sessionResult = () => Promise.resolve(null);
    render(<Probe id={1} />);
    expect(await settled()).toBe('none|true|false');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' }));
  });

  it('reports the synthetic admin as auth disabled with write access and no redirect', async () => {
    sessionResult = () => Promise.resolve(SYNTHETIC_ADMIN);
    render(<Probe id={1} />);
    expect(await settled()).toBe('none|false|true');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('redirects to /login and grants no write access when the session check fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    sessionResult = () => Promise.reject(new Error('network down'));
    render(<Probe id={1} />);
    try {
      expect(await settled()).toBe('none|false|false');
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' }));
      expect(mockGetSession).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
