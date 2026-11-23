import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import '@/lib/test/testing-library';
import { mockModule } from '@/lib/test/mock-module';
import { clearSession } from '@/lib/test/session';
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

function Probe({ id }: { id: number }) {
  const { user, loading, authEnabled } = useAuth();
  const canWrite = useCanWrite();
  return (
    <span data-testid={`probe-${id}`}>
      {loading ? 'loading' : `${user?.role ?? 'none'}|${String(authEnabled)}|${String(canWrite)}`}
    </span>
  );
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
