// API client for A Better Faucet server

export interface Network {
  id: string;
  name: string;
  chainId: number;
  explorerUrl: string;
  enabled: boolean;
  dispensationWei: string;
}

export interface Module {
  id: string;
  name: string;
  description: string;
  currentEpoch: number;
  epochDurationSeconds: number;
  originChainId?: number;
  originChainName?: string;
  minBalanceWei?: string;
}

export interface ClaimRequest {
  moduleId: string;
  proof: string;
  publicInputs: {
    stateRoot: string;
    epoch: number;
    minBalance: string;
    nullifier: string;
    blockNumber: string;
  };
  recipient: string;
  targetNetwork: string;
}

export interface ClaimResponse {
  claimId: string;
  txHash: string;
  network: string;
  amount: string;
}

export interface StatusResponse {
  claimId: string;
  status: 'pending' | 'confirmed' | 'failed';
  txHash?: string;
  network?: string;
}

export interface StorageProofResponse {
  balance: string;
  nonce: string;
  codeHash: string;
  storageHash: string;
  accountProof: string[];
  stateRoot: string;
  blockNumber: string;
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      const apiErr = data as { error: { code: string; message: string } };
      throw new ApiRequestError(
        apiErr.error?.message ?? `HTTP ${res.status}`,
        apiErr.error?.code ?? 'UNKNOWN',
        res.status,
      );
    }

    return data as T;
  }

  async getNetworks(): Promise<Network[]> {
    const data = await this.request<{ networks: Network[] }>('/networks');
    return data.networks;
  }

  async getModules(): Promise<Module[]> {
    const data = await this.request<{ modules: Module[] }>('/modules');
    return data.modules;
  }

  async submitClaim(req: ClaimRequest): Promise<ClaimResponse> {
    return this.request<ClaimResponse>('/claim', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async getStatus(claimId: string): Promise<StatusResponse> {
    return this.request<StatusResponse>(`/status/${encodeURIComponent(claimId)}`);
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  async getCircuitArtifact(moduleId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/circuits/${moduleId}/artifact.json`);
    if (!res.ok) {
      throw new ApiRequestError(
        `Failed to fetch circuit artifact: HTTP ${res.status}`,
        'ARTIFACT_FETCH_FAILED',
        res.status,
      );
    }
    return res.json();
  }
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  version: string;
  faucetAddress: string;
  balances: Record<string, string>;
}

export class ApiRequestError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const api = new ApiClient();
