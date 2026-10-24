import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { StackContainer } from '@/types/stacks';
import type { ImageChangelog, ImageUpdateSummary } from '@/types/image-updates';
import { mockModule } from '@/lib/test/mock-module';

const mockGetImageChangelog = mock(
  async (_opts: { data: { stack: string; host: string; image: string } }): Promise<ImageChangelog> => ({
    image: '',
    sourceRepo: null,
    releases: [],
    error: null,
  }),
);

mockModule<typeof import('@/data/stacks/functions')>('@/data/stacks/functions', (real) => ({
  ...real,
  getImageChangelog: mockGetImageChangelog,
}));

const { default: ImageUpdateDialog } = await import('@/components/stacks/ImageUpdateDialog');

const container: StackContainer = {
  id: 'c1',
  name: 'app-1',
  status: 'running',
  image: 'example-org/mock-app:2',
  service: 'app',
  ports: [],
  mounts: [],
};

const summary: ImageUpdateSummary = {
  image: 'example-org/mock-app:2',
  currentTag: '2',
  latestMatchingTag: '2.9.4',
  latestOverallTag: '3.0.0',
  updateAvailable: true,
  sourceRepo: 'example-org/mock-app',
  error: null,
};

const releases: ImageChangelog['releases'] = [
  {
    tagName: 'v2.9.4',
    name: null,
    publishedAt: '2026-09-01T12:00:00Z',
    url: 'https://github.com/example-org/mock-app/releases/tag/v2.9.4',
    body: '### Fixes\n\n- Fixed a crash on startup',
    prerelease: false,
  },
  {
    tagName: 'v2.9.0',
    name: null,
    publishedAt: '2026-08-01T12:00:00Z',
    url: null,
    body: null,
    prerelease: false,
  },
  {
    tagName: 'v3.0.0',
    name: null,
    publishedAt: '2026-10-01T12:00:00Z',
    url: 'https://github.com/example-org/mock-app/releases/tag/v3.0.0',
    body: '### Breaking changes',
    prerelease: false,
  },
];

function changelogResult(overrides?: Partial<ImageChangelog>): ImageChangelog {
  return {
    image: container.image,
    sourceRepo: 'example-org/mock-app',
    releases,
    error: null,
    ...overrides,
  };
}

function renderDialog(props?: {
  container?: StackContainer;
  summary?: ImageUpdateSummary | null;
  open?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <ImageUpdateDialog
      open={props?.open ?? true}
      onClose={() => {}}
      stackName="myapp"
      host="server1"
      container={props?.container ?? container}
      summary={props?.summary === undefined ? summary : props.summary}
    />,
    { wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ) },
  );
}

describe('ImageUpdateDialog', () => {
  beforeEach(() => {
    mockGetImageChangelog.mockImplementation(async () => changelogResult());
  });

  it('renders releases filtered to the running tag constraint by default', async () => {
    renderDialog();
    expect(await screen.findByText('v2.9.4')).toBeDefined();
    expect(screen.getByText('v2.9.0')).toBeDefined();
    expect(screen.queryByText('v3.0.0')).toBeNull();
  });

  it('shows out-of-constraint releases after picking All releases', async () => {
    renderDialog();
    await screen.findByText('v2.9.4');
    fireEvent.click(screen.getByRole('button', { name: 'All releases' }));
    expect(screen.getByText('v3.0.0')).toBeDefined();
  });

  it('renders release dates, markdown bodies, and release note links', async () => {
    renderDialog();
    await screen.findByText('v2.9.4');
    expect(screen.getByText('Fixes')).toBeDefined();
    expect(screen.getByText('Fixed a crash on startup')).toBeDefined();
    const link = document.querySelector('a[href="https://github.com/example-org/mock-app/releases/tag/v2.9.4"]');
    expect(link?.textContent).toBe('Release notes');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(document.querySelector('[data-slot="dialog-body"]')?.textContent).toContain('2026');
  });

  it('shows the update-available badge with the newest matching tag', async () => {
    renderDialog();
    await screen.findByText('v2.9.4');
    expect(screen.getByText('Update available: 2.9.4')).toBeDefined();
  });

  it('pins the exact footer sentence', async () => {
    renderDialog();
    await screen.findByText('v2.9.4');
    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.textContent ?? '').toContain(
      'Click "Update images" in the stack action bar to update example-org/mock-app to 2.9.4.',
    );
  });

  it('falls back to latestOverallTag then currentTag in the footer', async () => {
    mockGetImageChangelog.mockImplementation(async () => changelogResult());
    renderDialog({
      summary: { ...summary, updateAvailable: false, latestMatchingTag: null, latestOverallTag: '3.0.0' },
    });
    await screen.findByText('v2.9.4');
    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.textContent ?? '').toContain('to update example-org/mock-app to 3.0.0.');
  });

  it('shows the changelog error as a plain sentence', async () => {
    mockGetImageChangelog.mockImplementation(async () =>
      changelogResult({ releases: [], sourceRepo: null, error: 'No GitHub source repository found for this image' }),
    );
    renderDialog();
    expect(await screen.findByText('No GitHub source repository found for this image')).toBeDefined();
    expect(screen.queryByText('v2.9.4')).toBeNull();
  });

  it('says No releases published when the changelog is empty without error', async () => {
    mockGetImageChangelog.mockImplementation(async () => changelogResult({ releases: [] }));
    renderDialog();
    expect(await screen.findByText('No releases published')).toBeDefined();
  });

  it('defaults to all releases and hides the toggle for a floating tag', async () => {
    renderDialog({
      container: { ...container, image: 'example-org/mock-app:latest' },
      summary: { ...summary, image: 'example-org/mock-app:latest', currentTag: 'latest', latestMatchingTag: null, updateAvailable: null },
    });
    expect(await screen.findByText('v3.0.0')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'All releases' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Matching latest' })).toBeNull();
    expect(screen.getByText('Floating tag (latest)')).toBeDefined();
  });

  it('uses a re-pull footer sentence for floating tags instead of naming a version', async () => {
    renderDialog({
      container: { ...container, image: 'example-org/mock-app:latest' },
      summary: { ...summary, image: 'example-org/mock-app:latest', currentTag: 'latest', latestMatchingTag: null, updateAvailable: true },
    });
    await screen.findByText('v3.0.0');
    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer?.textContent ?? '').toContain(
      'Click "Update images" in the stack action bar to pull the newest latest build of example-org/mock-app.',
    );
  });

  it('shows the update-available badge for a floating tag whose digest moved', async () => {
    renderDialog({
      container: { ...container, image: 'example-org/mock-app:latest' },
      summary: { ...summary, image: 'example-org/mock-app:latest', currentTag: 'latest', latestMatchingTag: null, updateAvailable: true },
    });
    expect(await screen.findByText('Update available')).toBeDefined();
  });

  it('shows Check failed when the summary carries an error', async () => {
    renderDialog({
      summary: { ...summary, error: 'registry unreachable', updateAvailable: null },
    });
    expect(await screen.findByText('Check failed')).toBeDefined();
  });
});