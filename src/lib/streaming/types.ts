/** Core abstractions shared by the worker's streaming data sources (database connections). */

/** Client that owns a long-lived connection; implemented by DatabaseClient. */
export interface StreamingClient {
  id: string;
  isConnected(): boolean;
  close(): Promise<void>;
}
