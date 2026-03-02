import { formatEther } from 'viem';
import type { ClaimResponse, Network } from '../../lib/api';
import { ResultCard } from '../ResultCard';
import { FAUCET_LOW_BALANCE_WEI } from '../../lib/wallet-config';

function formatWei(wei: string): string {
  return Number(formatEther(BigInt(wei))).toFixed(4) + ' ETH';
}

interface ClaimStepProps {
  networks: Network[];
  recipient: string;
  targetNetwork: string;
  onRecipientChange: (value: string) => void;
  onNetworkChange: (value: string) => void;
  result: ClaimResponse | null;
  loading: boolean;
  balances?: Record<string, string>;
}

export function ClaimStep({
  networks,
  recipient,
  targetNetwork,
  onRecipientChange,
  onNetworkChange,
  result,
  loading,
  balances,
}: ClaimStepProps) {
  const isValidAddress = /^0x[0-9a-fA-F]{40}$/.test(recipient);
  const showValidation = recipient.length > 0 && !isValidAddress;

  const selectedBalance = targetNetwork && balances?.[targetNetwork] && balances[targetNetwork] !== 'error'
    ? balances[targetNetwork]
    : null;
  const isLowBalance = selectedBalance ? BigInt(selectedBalance) < FAUCET_LOW_BALANCE_WEI : false;

  if (result) {
    return <ResultCard result={result} networks={networks} />;
  }

  return (
    <div>
      <div className="form-group">
        <label htmlFor="recipient-input">Recipient Address</label>
        <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
          Enter the <strong>testnet address</strong> where you want to receive funds.
          This address will not be linked to your mainnet wallet in any way.
        </p>
        <input
          type="text"
          id="recipient-input"
          placeholder="0x..."
          spellCheck={false}
          autoComplete="off"
          value={recipient}
          onChange={(e) => onRecipientChange(e.target.value)}
          style={showValidation ? { borderColor: 'var(--error)' } : undefined}
        />
      </div>

      <div className="form-group">
        <label htmlFor="network-select">Target Network</label>
        {loading ? (
          <div className="skeleton" />
        ) : (
          <>
            <select
              id="network-select"
              value={targetNetwork}
              onChange={(e) => onNetworkChange(e.target.value)}
            >
              <option value="">Select network...</option>
              {networks
                .filter((n) => n.enabled)
                .map((net) => (
                  <option key={net.id} value={net.id}>
                    {net.name} ({formatWei(net.dispensationWei)})
                  </option>
                ))}
            </select>
            {selectedBalance && (
              <div className={`network-balance${isLowBalance ? ' low' : ''}`}>
                {isLowBalance && <span className="low-indicator">&#9888;</span>}
                {formatWei(selectedBalance)} available
                {isLowBalance && <span className="low-label">low funds</span>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
