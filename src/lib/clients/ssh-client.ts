import { Client, ClientChannel } from 'ssh2';
import type { SSHConnectionConfig, StreamingClient } from '../streaming/types';
import { readFileSync } from 'fs';

export class SSHClient implements StreamingClient {
  readonly id: string;
  private client: Client;
  private config: SSHConnectionConfig;
  private connected: boolean = false;
  private channels: Set<ClientChannel> = new Set();
  private lastUsed: number = Date.now();

  constructor(config: SSHConnectionConfig) {
    this.config = config;
    this.id = `ssh://${config.auth.username}@${config.host}:${config.port || 22}`;
    this.client = new Client();
  }

  /**
   * Establish SSH connection
   * Wraps callback-based SSH2 API in promises
   */
  async connect(): Promise<void> {
    if (this.connected) {
      this.lastUsed = Date.now();
      return;
    }

    console.log(`[SSHClient] Attempting connection to ${this.id}...`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error(`[SSHClient] Connection timeout after 10 seconds`);
        this.client.end();
        reject(new Error(`SSH connection timeout to ${this.config.host}`));
      }, 10000); // 10 second timeout

      this.client
        .on('banner', (msg) => {
          console.log(`[SSHClient] Banner: ${msg}`);
        })
        //.on('keyboard-interactive', (name, instructions, prompts, finish) => {
        //  console.log(`[SSHClient] Keyboard-interactive auth requested`);
        //})
        .on('ready', () => {
          clearTimeout(timeout);
          this.connected = true;
          this.lastUsed = Date.now();
          console.log(`[SSHClient] ✓ Connected successfully to ${this.id}`);
          resolve();
        })
        .on('error', (err) => {
          clearTimeout(timeout);
          this.connected = false;
          console.error(`[SSHClient] ✗ Connection error:`, err);
          reject(err);
        })
        .on('close', () => {
          this.connected = false;
          console.log(`[SSHClient] Connection closed: ${this.id}`);
        })
        .connect(this.buildSSHConfig());

      console.log(`[SSHClient] SSH connection initiated...`);
    });
  }

  /**
   * Execute a command and return the stdout stream
   * Converts callback-based exec to promise-based API
   */
  async exec(command: string): Promise<NodeJS.ReadableStream> {
    if (!this.connected) {
      throw new Error('SSH client not connected');
    }

    this.lastUsed = Date.now();

    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }

        // Track channel for cleanup
        this.channels.add(channel);

        // Handle channel events
        channel
          .on('close', () => {
            this.channels.delete(channel);
            console.log(`[SSHClient] Channel closed for command: ${command}`);
          })
          .stderr.on('data', (data) => {
            console.error(`[SSHClient] STDERR: ${data}`);
          });

        // Return the channel as a readable stream (stdout)
        resolve(channel);
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get last usage timestamp (for connection pooling)
   */
  getLastUsed(): number {
    return this.lastUsed;
  }

  /**
   * Check if there are active channels (streaming commands)
   */
  hasActiveChannels(): boolean {
    return this.channels.size > 0;
  }

  /**
   * Close all channels and disconnect
   */
  async close(): Promise<void> {
    console.log(`[SSHClient] Closing connection: ${this.id}`);

    // Close all active channels
    for (const channel of this.channels) {
      try {
        channel.close();
      } catch (err) {
        console.error('[SSHClient] Error closing channel:', err);
      }
    }
    this.channels.clear();

    // End SSH connection
    this.client.end();
    this.connected = false;
  }

  /**
   * Build SSH2 connection config from our config
   */
  private buildSSHConfig() {
    const auth = this.config.auth;
    const sshConfig: any = {
      host: this.config.host,
      port: this.config.port || 22,
      username: auth.username,
      readyTimeout: 10000,
    };

    // Add keepalive if specified
    if (this.config.keepaliveInterval) {
      sshConfig.keepaliveInterval = this.config.keepaliveInterval;
    }

    // Configure authentication
    switch (auth.type) {
      case 'password':
        sshConfig.password = auth.password;
        break;

      case 'privateKey':
        if (auth.privateKey) {
          sshConfig.privateKey = auth.privateKey;
        } else if (auth.privateKeyPath) {
          sshConfig.privateKey = readFileSync(auth.privateKeyPath);
        }
        if (auth.passphrase) {
          sshConfig.passphrase = auth.passphrase;
        }
        break;

      case 'agent':
        sshConfig.agent = process.env.SSH_AUTH_SOCK;
        break;
    }

    return sshConfig;
  }
}

/**
 * Connection pool manager for SSH clients
 * Singleton pattern with automatic cleanup
 */
class SSHConnectionManager {
  private connections = new Map<string, SSHClient>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly TTL = 60 * 1000; // 1 minute

  constructor() {
    this.startCleanup();
  }

  /**
   * Get or create an SSH client for the given config
   */
  async getClient(config: SSHConnectionConfig): Promise<SSHClient> {
    const key = `${config.auth.username}@${config.host}:${config.port || 22}`;

    let client = this.connections.get(key);

    if (!client || !client.isConnected()) {
      console.log(`[SSHConnectionManager] Creating new connection: ${key}`);
      client = new SSHClient(config);
      await client.connect();
      this.connections.set(key, client);
    }

    return client;
  }

  /**
   * Explicitly close a specific connection
   */
  async closeConnection(id: string): Promise<void> {
    const client = this.connections.get(id);
    if (client) {
      await client.close();
      this.connections.delete(id);
    }
  }

  /**
   * Close all connections
   */
  async closeAll(): Promise<void> {
    console.log('[SSHConnectionManager] Closing all connections');
    this.stopCleanup();
    const promises = Array.from(this.connections.values()).map(client => client.close());
    await Promise.all(promises);
    this.connections.clear();
  }

  /**
   * Start background cleanup of stale connections
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, client] of this.connections.entries()) {
        // Skip connections with active streaming channels
        if (client.hasActiveChannels()) {
          continue;
        }
        if (now - client.getLastUsed() > this.TTL) {
          console.log(`[SSHConnectionManager] Cleaning up stale connection: ${key}`);
          client.close();
          this.connections.delete(key);
        }
      }
    }, 60000); // Run every minute
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton instance
export const sshConnectionManager = new SSHConnectionManager();
