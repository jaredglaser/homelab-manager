import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { Notification } from '@/lib/database/repositories/notification-repository';

/**
 * Get all undismissed notifications.
 */
export const getNotifications = createServerFn()
  .handler(async (): Promise<Notification[]> => {
    try {
      const { databaseConnectionManager } = await import(
        '@/lib/clients/database-client'
      );
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { NotificationRepository } = await import(
        '@/lib/database/repositories/notification-repository'
      );

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new NotificationRepository(dbClient.getPool());

      return await repo.getUndismissed();
    } catch (err) {
      console.error('[getNotifications] Failed to fetch notifications:', err);
      return [];
    }
  });

const dismissNotificationSchema = z.object({
  id: z.number(),
});

/**
 * Dismiss a single notification by ID.
 */
export const dismissNotification = createServerFn()
  .inputValidator(dismissNotificationSchema)
  .handler(async ({ data }): Promise<void> => {
    try {
      const { databaseConnectionManager } = await import(
        '@/lib/clients/database-client'
      );
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { NotificationRepository } = await import(
        '@/lib/database/repositories/notification-repository'
      );

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new NotificationRepository(dbClient.getPool());

      await repo.dismiss(data.id);
    } catch (err) {
      console.error('[dismissNotification] Failed to dismiss notification:', err);
    }
  });

/**
 * Dismiss all undismissed notifications.
 */
export const dismissAllNotifications = createServerFn()
  .handler(async (): Promise<void> => {
    try {
      const { databaseConnectionManager } = await import(
        '@/lib/clients/database-client'
      );
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { NotificationRepository } = await import(
        '@/lib/database/repositories/notification-repository'
      );

      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      const repo = new NotificationRepository(dbClient.getPool());

      await repo.dismissAll();
    } catch (err) {
      console.error('[dismissAllNotifications] Failed to dismiss all notifications:', err);
    }
  });
