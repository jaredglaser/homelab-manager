/** Core abstractions shared by the worker's streaming data sources (database connections, line-oriented text parsers). */

/** Client that owns a long-lived connection; implemented by DatabaseClient. */
export interface StreamingClient {
  id: string;
  isConnected(): boolean;
  close(): Promise<void>;
}

/** Context passed to parsers */
export interface ParseContext {
  /** Previous line, for stateful parsing */
  previousLine?: string;
  headers?: Record<string, unknown>;
  lineNumber: number;
}
