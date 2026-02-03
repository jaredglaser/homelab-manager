/**
 * Core abstractions for streaming data sources
 * These interfaces enable a modular, extensible architecture for Docker, SSH, HTTP, and future sources
 */

/**
 * Generic interface for any streaming data source
 * Implementations include Docker, SSH, HTTP, WebSocket, etc.
 */
export interface StreamingClient {
  /** Identifier for this client instance */
  id: string;

  /** Check if the connection is alive */
  isConnected(): boolean;

  /** Cleanup and close the connection */
  close(): Promise<void>;
}

/**
 * Configuration for establishing a streaming connection
 */
export interface ConnectionConfig {
  /** Unique identifier for this connection */
  id: string;

  /** Type of connection (docker, ssh, http, etc.) */
  type: 'docker' | 'ssh' | 'http';

  /** Host address or socket path */
  host: string;

  /** Port number (optional for socket connections) */
  port?: number;

  /** Additional connection-specific options */
  options?: Record<string, unknown>;
}

/**
 * Authentication credentials for remote connections
 */
export interface AuthCredentials {
  type: 'password' | 'privateKey' | 'agent';
  username: string;
  password?: string;
  privateKeyPath?: string;
  privateKey?: Buffer;
  passphrase?: string;
}

/**
 * Configuration for SSH connections
 */
export interface SSHConnectionConfig extends ConnectionConfig {
  type: 'ssh';
  auth: AuthCredentials;
  /** Optional keepalive interval in ms */
  keepaliveInterval?: number;
}

/**
 * Result of a streaming operation
 * Generic T represents the parsed data type
 */
export interface StreamResult<T> {
  /** Unique identifier for the source (container ID, device name, etc.) */
  id: string;

  /** Display name */
  name: string;

  /** Timestamp when this data was received */
  timestamp: number;

  /** The actual data payload */
  data: T;
}

/**
 * Context passed to parsers
 */
export interface ParseContext {
  /** Previous line (for stateful parsing) */
  previousLine?: string;

  /** Header metadata */
  headers?: Record<string, unknown>;

  /** Line number in stream */
  lineNumber: number;
}

/**
 * Generic interface for parsing streaming text data
 */
export interface StreamParser<T> {
  /** Parse a line of text and return typed data, or null if invalid */
  parseLine(line: string, context?: ParseContext): T | null;

  /** Optional: Validate if we should process this line */
  shouldProcessLine?(line: string): boolean;

  /** Optional: Extract metadata from header lines */
  parseHeader?(line: string): Record<string, unknown>;
}

/**
 * Generic rate calculator interface
 */
export interface RateCalculator<TInput, TOutput> {
  /** Calculate rates from current data using cached previous values */
  calculate(id: string, current: TInput): TOutput;

  /** Clear all cached data */
  clear(): void;

  /** Remove specific entry from cache */
  remove(id: string): void;
}
