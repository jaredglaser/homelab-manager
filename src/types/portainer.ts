export interface PortainerEndpoint {
  Id: number;
  Name: string;
  URL: string;
  PublicURL: string;
  Type: number;
  Status: number;
}

export interface PortainerStack {
  Id: number;
  Name: string;
  Type: number;
  EndpointId: number;
  Status: number;
  Env?: Array<{ name: string; value: string }>;
}
