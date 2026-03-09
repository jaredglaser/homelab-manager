import type { Pool } from 'pg';

export interface Notification {
  id: number;
  type: string;
  severity: 'success' | 'error' | 'warning';
  title: string;
  message: string;
  created_at: string;
}

export class NotificationRepository {
  constructor(private pool: Pool) {}

  async createNotification(type: string, severity: string, title: string, message: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO notifications (type, severity, title, message) VALUES ($1, $2, $3, $4)',
      [type, severity, title, message]
    );
  }

  async getUndismissed(): Promise<Notification[]> {
    const result = await this.pool.query(
      'SELECT id, type, severity, title, message, created_at FROM notifications WHERE dismissed = FALSE ORDER BY created_at DESC'
    );
    return result.rows;
  }

  async dismiss(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE notifications SET dismissed = TRUE WHERE id = $1',
      [id]
    );
  }

  async dismissAll(): Promise<void> {
    await this.pool.query(
      'UPDATE notifications SET dismissed = TRUE WHERE dismissed = FALSE'
    );
  }
}
