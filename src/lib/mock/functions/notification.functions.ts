/**
 * Mock notification server functions for demo mode.
 */

import type { Notification } from '@/lib/database/repositories/notification-repository';

export const getNotifications = async (): Promise<Notification[]> => {
  return [];
};

export const dismissNotification = async (
  _opts?: {
    data?: { id: number };
  },
): Promise<void> => {
  // No-op in demo mode
};

export const dismissAllNotifications = async (): Promise<void> => {
  // No-op in demo mode
};
