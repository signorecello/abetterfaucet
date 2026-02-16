export interface ServerConfig {
  ethRpcUrl: string;
  originChainId: number;
  faucetPrivateKey: `0x${string}`;
  port: number;
  host: string;
  logLevel: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  dispensationAmountEth: string;
  epochDuration: number;
  minBalanceWei: bigint;
  dbPath: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): ServerConfig {
  const faucetPrivateKey = requireEnv("FAUCET_PRIVATE_KEY");
  if (!faucetPrivateKey.startsWith("0x")) {
    throw new Error("FAUCET_PRIVATE_KEY must start with 0x");
  }

  const originChainId = parseInt(requireEnv("ORIGIN_CHAINID"), 10);
  if (![1, 11155111, 17000].includes(originChainId)) {
    throw new Error(`Unsupported ORIGIN_CHAINID: ${originChainId}. Must be 1, 11155111, or 17000`);
  }

  return {
    ethRpcUrl: requireEnv("ORIGIN_RPC_URL"),
    originChainId,
    faucetPrivateKey: faucetPrivateKey as `0x${string}`,
    port: parseInt(optionalEnv("PORT", "3000"), 10),
    host: optionalEnv("HOST", "0.0.0.0"),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    rateLimitMax: parseInt(optionalEnv("RATE_LIMIT_MAX", "10"), 10),
    rateLimitWindowMs: parseInt(optionalEnv("RATE_LIMIT_WINDOW_MS", "60000"), 10),
    dispensationAmountEth: optionalEnv("DISPENSATION_AMOUNT", "0.1"),
    epochDuration: parseInt(optionalEnv("EPOCH_DURATION", "604800"), 10),
    minBalanceWei: BigInt(requireEnv("MIN_BALANCE_WEI")),
    dbPath: optionalEnv("DB_PATH", "./data/nullifiers.db"),
  };
}
