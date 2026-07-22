/**
 * Core abstractions shared by the worker's streaming data sources
 * (database connections, line-oriented text parsers).
 */

/**
 * Generic interface for a client that owns a long-lived connection.
 * Implemented by DatabaseClient.
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
  parseHeader?(line: string): Record<string, unknown> | undefined;
}
