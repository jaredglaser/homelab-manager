import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser, Role } from '@/lib/auth/types';
import { withStartContext } from '@/lib/test/start-context';
import { mockModule } from '@/lib/test/mock-module';
import { ForbiddenError } from '@/lib/auth/require-role';
import type * as AuthMiddleware from '@/middleware/auth-middleware';
import type * as DatabaseMiddleware from '@/middleware/database-middleware';
import type * as EntityMetadataRepository from '@/lib/database/repositories/entity-metadata-repository';

let activeUser: AuthUser = SYNTHETIC_ADMIN;

async function withRole<T>(role: Role, run: () => Promise<T>): Promise<T> {
  activeUser = { ...SYNTHETIC_ADMIN, role };
  try {
    return await run();
  } finally {
    activeUser = SYNTHETIC_ADMIN;
  }
}

type Next = (opts: { sendContext?: unknown; context?: unknown }) => unknown;

mockModule<typeof AuthMiddleware>('@/middleware/auth-middleware', (real) => ({ ...real,
  authMiddleware: {
    options: {
      type: 'function',
      client: ({ next, sendContext }: { next: Next; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), user: activeUser } }),
      server: ({ next, context }: { next: Next; context: unknown }) =>
        next({ context: { ...(context as Record<string, unknown>), user: activeUser } }),
    },
  },
}));

mockModule<typeof DatabaseMiddleware>('@/middleware/database-middleware', (real) => ({ ...real,
  databaseMiddleware: {
    options: {
      type: 'function',
      client: ({ next, sendContext }: { next: Next; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), pool: {} } }),
      server: ({ next, context }: { next: Next; context: unknown }) =>
        next({ context: { ...(context as Record<string, unknown>), pool: {} } }),
    },
  },
}));

const mockUpsertEntityMetadata = mock(() => Promise.resolve());
const mockDeleteEntityIcon = mock(() => Promise.resolve());

mockModule<typeof EntityMetadataRepository>(
  '@/lib/database/repositories/entity-metadata-repository',
  (real) => ({ ...real,
    EntityMetadataRepository: class {
      upsertEntityMetadata = mockUpsertEntityMetadata;
      deleteEntityIcon = mockDeleteEntityIcon;
    },
  }),
);

const serviceKeyEntity = 'server1/compose:web';

describe('container icon server functions', () => {
  beforeEach(() => {
    mockUpsertEntityMetadata.mockClear();
    mockDeleteEntityIcon.mockClear();
  });

  describe('updateContainerIcon', () => {
    it('refuses a viewer without writing metadata', async () => {
      const { updateContainerIcon } = await import('../functions');
      const error = await withRole('viewer', () =>
        withStartContext(() => updateContainerIcon({ data: { serviceKeyEntity, iconSlug: 'nginx' } })),
      ).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(mockUpsertEntityMetadata).not.toHaveBeenCalled();
    });

    it.each(['admin', 'operator'] as const)('stores the icon for an %s', async (role) => {
      const { updateContainerIcon } = await import('../functions');
      await withRole(role, () => withStartContext(() => updateContainerIcon({ data: { serviceKeyEntity, iconSlug: 'nginx' } })));
      expect(mockUpsertEntityMetadata).toHaveBeenCalledWith(serviceKeyEntity, 'icon', 'nginx');
    });
  });

  describe('clearContainerIcon', () => {
    it('refuses a viewer without deleting metadata', async () => {
      const { clearContainerIcon } = await import('../functions');
      const error = await withRole('viewer', () =>
        withStartContext(() => clearContainerIcon({ data: { serviceKeyEntity } })),
      ).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(mockDeleteEntityIcon).not.toHaveBeenCalled();
    });

    it.each(['admin', 'operator'] as const)('clears the icon for an %s', async (role) => {
      const { clearContainerIcon } = await import('../functions');
      await withRole(role, () => withStartContext(() => clearContainerIcon({ data: { serviceKeyEntity } })));
      expect(mockDeleteEntityIcon).toHaveBeenCalledWith(serviceKeyEntity);
    });
  });
});
