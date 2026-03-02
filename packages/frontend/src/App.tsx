import { useState, useEffect } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from './lib/wallet-config';
import { api, type HealthResponse } from './lib/api';
import { EpochBar } from './components/EpochBar';
import { StepList } from './components/Steps/StepList';

const queryClient = new QueryClient();

function FaucetInfo() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    api.getHealth().then(setHealth).catch(() => {});
  }, []);

  if (!health) return null;

  return (
    <div className="faucet-info">
      <a className="faucet-address" href={`https://sepolia.etherscan.io/address/${health.faucetAddress}`} target="_blank" rel="noopener noreferrer">
        faucet: <span className="text-accent">{health.faucetAddress}</span>
      </a>
    </div>
  );
}

export function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <div className="app">
          <header className="header">
            <h1>a better faucet</h1>
            <p>privacy-preserving testnet faucet powered by ZK proofs</p>
          </header>

          <FaucetInfo />
          <EpochBar />
          <StepList />

          <div className="privacy-banner">
            <svg className="privacy-banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            <span>Your proof is generated entirely in your browser. Private data (address, signature, balance) never leaves your device. The server only receives the ZK proof.</span>
          </div>

          <footer className="footer">
            <div className="footer-links">
              <a href="https://github.com/signorecello/abetterfaucet" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                </svg>
              </a>
              <a href="https://x.com/zkpedrongmi" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
              </a>
            </div>
            <p>built by <span className="text-accent">zkpedro</span> with Noir, Hono and Bun</p>
          </footer>
        </div>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
