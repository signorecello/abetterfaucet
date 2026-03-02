import { useState, useCallback, useEffect } from 'react';
import { useDisconnect, useBalance, useSwitchChain } from 'wagmi';
import { useAppKit, useAppKitAccount } from '@reown/appkit/react';
import { formatEther } from 'viem';
import { MIN_BALANCE_WEI } from '../../lib/wallet-config';
import type { Module } from '../../lib/api';

function truncateAddress(address: string): string {
  return address.slice(0, 6) + '...' + address.slice(-4);
}

function formatBalance(wei: bigint): string {
  return Number(formatEther(wei)).toFixed(4);
}

interface ConnectStepProps {
  modules: Module[];
  selectedModuleId: string;
  onModuleChange: (moduleId: string) => void;
  onContinue: () => void;
}

function ChainBalance({ chainId, minBalance, onBalanceLoaded }: {
  chainId: number;
  minBalance: bigint;
  onBalanceLoaded?: (chainId: number, sufficient: boolean) => void;
}) {
  const { address } = useAppKitAccount();
  const { data: balanceData } = useBalance({
    address: address as `0x${string}` | undefined,
    chainId,
  });

  const balance = balanceData?.value ?? null;
  const sufficient = balance !== null && balance >= minBalance;
  const balStr = balance !== null ? formatBalance(balance) : '...';

  useEffect(() => {
    if (balance !== null) {
      onBalanceLoaded?.(chainId, sufficient);
    }
  }, [balance, sufficient, chainId, onBalanceLoaded]);

  return (
    <span className={`wallet-balance ${balance !== null ? (sufficient ? 'sufficient' : 'insufficient') : ''}`}>
      {balStr} ETH{balance !== null ? (sufficient ? ' [ok]' : ' [insufficient]') : ''}
    </span>
  );
}

export function ConnectStep({ modules, selectedModuleId, onModuleChange, onContinue }: ConnectStepProps) {
  const { address, isConnected } = useAppKitAccount();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const originModules = modules.filter((m) => m.originChainId != null);

  const [balanceStatus, setBalanceStatus] = useState<Map<number, boolean>>(new Map());
  const handleBalanceLoaded = useCallback((chainId: number, sufficient: boolean) => {
    setBalanceStatus(prev => {
      const next = new Map(prev);
      next.set(chainId, sufficient);
      return next;
    });
  }, []);

  if (!isConnected || !address) {
    return (
      <div>
        <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
          Connect the <strong>mainnet wallet</strong> you want to prove balance for.
          Your address and balance will never leave your device. They are only used
          locally to generate a zero-knowledge proof.
        </p>
        <button
          className="btn btn-secondary"
          onClick={() => open()}
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  const handleModuleChange = (moduleId: string) => {
    onModuleChange(moduleId);
    const mod = modules.find((m) => m.id === moduleId);
    if (mod?.originChainId) {
      switchChain?.({ chainId: mod.originChainId });
    }
  };

  const minBal = MIN_BALANCE_WEI;
  const allLoaded = balanceStatus.size >= originModules.length;
  const anyChainSufficient = [...balanceStatus.values()].some(Boolean);

  return (
    <div>
      <div className="wallet-status connected">
        <div>
          <span className="wallet-address">{truncateAddress(address)}</span>
        </div>
        <button className="wallet-disconnect" onClick={() => disconnect()}>
          disconnect
        </button>
      </div>

      {originModules.length > 0 && (
        <div className="origin-balances">
          {originModules.map((mod) => (
            <button
              key={mod.id}
              type="button"
              className={`origin-balance-row${originModules.length > 1 ? ' selectable' : ''}${mod.id === selectedModuleId ? ' selected' : ''}`}
              onClick={() => originModules.length > 1 && handleModuleChange(mod.id)}
            >
              <span className="origin-chain-name">{mod.originChainName}</span>
              <ChainBalance
                chainId={mod.originChainId!}
                minBalance={mod.minBalanceWei ? BigInt(mod.minBalanceWei) : minBal}
                onBalanceLoaded={handleBalanceLoaded}
              />
            </button>
          ))}
        </div>
      )}

      <p className="text-sm text-muted" style={{ marginTop: 12, marginBottom: 12 }}>
        Your address and balance stay private. They never leave your browser.
      </p>

      {allLoaded && !anyChainSufficient && (
        <div className="message message-error" style={{ marginBottom: 12 }}>
          Insufficient balance. You need at least {Number(formatEther(minBal)).toFixed(4)} ETH on any supported origin chain.
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={onContinue}
        disabled={!allLoaded || !anyChainSufficient}
      >
        Continue
      </button>
    </div>
  );
}
