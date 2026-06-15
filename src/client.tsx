import { StrictMode, startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { StartClient } from '@tanstack/react-start/client';

import { IS_MOCK_ENABLED } from '@/lib/constants/mock';

/**
 * Custom client entry. When mocks are enabled (demo or the Playwright app
 * target) the MSW service worker must be active before the router runs its
 * first loaders, which fire during hydration and would otherwise hit the real
 * backend. Starting it here, before `hydrateRoot`, is the only point early
 * enough to guarantee that; a React-level gate cannot cover pre-render loaders.
 * In production this branch is dead, so hydration is unchanged.
 */
async function bootstrap(): Promise<void> {
  if (IS_MOCK_ENABLED) {
    const { startMockServiceWorker } = await import('@/lib/mock/start');
    await startMockServiceWorker();
  }

  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
    );
  });
}

void bootstrap();
