import { createFileRoute } from '@tanstack/react-router';
import { createHash } from 'crypto';

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { isAuthDisabled, loadAuthConfig } = await import('@/lib/config/auth-config');
        let isSecure = false;
        if (!isAuthDisabled()) {
          const config = loadAuthConfig();
          isSecure = config.redirectUri.startsWith('https://');

          // Extract session, delete from DB
          const cookieHeader = request.headers.get('cookie') ?? '';
          const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
          const token = match ? decodeURIComponent(match[1]) : null;

          if (token) {
            try {
              const hashedId = createHash('sha256').update(token).digest('hex');
              const { buildSessionManager } = await import('@/lib/auth/session-manager');
              const sessionManager = await buildSessionManager();
              await sessionManager.revokeSession(hashedId);
            } catch (err) {
              console.error('[auth/logout] Failed to revoke session:', err);
            }
          }
        }

        const securePart = isSecure ? ' Secure;' : '';

        // Clear session cookie, redirect to login page
        const clearCookie = `session=; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=0`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/login',
            'Set-Cookie': clearCookie,
          },
        });
      },
    },
  },
});
