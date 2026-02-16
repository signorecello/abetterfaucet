// zk_faucet frontend — entry point

// Polyfill Buffer for browser (required by @aztec/bb.js WASM internals)
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as any).Buffer = Buffer;
}

import { api, ApiRequestError } from "./api";
import type { Network, Module } from "./api";
import {
  initWallet,
  connectWallet,
  disconnectWallet,
  getWalletState,
  isMetaMaskAvailable,
  onWalletChange,
  formatBalance,
  hasMinBalance,
  signDomainMessage,
  getCurrentEpoch,
  getStorageProof,
  MIN_BALANCE_WEI,
} from "./wallet";
import {
  $,
  show,
  hide,
  setLoading,
  showMessage,
  showErrorWithHint,
  clearMessage,
  showView,
  isValidAddress,
  truncateAddress,
  formatWei,
  getExplorerTxUrl,
  statusBadgeHtml,
  formatEpochCountdown,
  escapeHtml,
  showToast,
  copyToClipboard,
  copyButtonHtml,
  scrollToElement,
  externalLinkHtml,
  successCheckHtml,
  updateStepIndicator,
  getFriendlyError,
  showProvingProgress,
  hideProvingProgress,
} from "./ui";

// --- App State ---
let networks: Network[] = [];
let modules: Module[] = [];
let epochTimer: ReturnType<typeof setInterval> | null = null;
let isClaimInProgress = false;

// --- Initialization ---
document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupNavigation();
  setupWalletListeners();
  setupFormListeners();
  setupCopyDelegation();
  setupKeyboardShortcuts();

  // Initialize wallet module (uses wallet's own provider, no server RPC needed)
  initWallet();

  // Show skeleton for network select while loading
  showNetworkSkeleton();

  // Load data from server
  await Promise.all([loadNetworks(), loadModules()]);

  // Start epoch countdown
  startEpochCountdown();

  // Render info view
  renderInfoView();

  // Initialize claim view state
  updateClaimViewState();
}

// --- Navigation ---
function setupNavigation() {
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-nav")!;
      showView(view);
    });
  });
}

// --- Data Loading ---
async function loadNetworks() {
  try {
    networks = await api.getNetworks();
    populateNetworkDropdown();
  } catch (err) {
    console.error("Failed to load networks:", err);
    showMessage(
      $("#claim-messages"),
      "Failed to load networks. Is the server running?",
      "error",
    );
  }
}

async function loadModules() {
  try {
    modules = await api.getModules();
    renderEpochBar();
  } catch (err) {
    console.error("Failed to load modules:", err);
  }
}

/** Show skeleton shimmer while networks are loading */
function showNetworkSkeleton() {
  const select = $("#network-select") as HTMLSelectElement | null;
  if (!select) return;
  const parent = select.parentElement;
  if (!parent) return;

  select.style.display = "none";
  const skeleton = document.createElement("div");
  skeleton.className = "skeleton";
  skeleton.id = "network-skeleton";
  parent.appendChild(skeleton);
}

function populateNetworkDropdown() {
  const select = $("#network-select") as HTMLSelectElement | null;
  if (!select) return;

  const skeleton = document.getElementById("network-skeleton");
  if (skeleton) skeleton.remove();
  select.style.display = "";

  select.innerHTML = '<option value="">Select network...</option>';
  for (const net of networks) {
    if (!net.enabled) continue;
    const opt = document.createElement("option");
    opt.value = net.id;
    opt.textContent = `${net.name} (${formatWei(net.dispensationWei)})`;
    select.appendChild(opt);
  }
}

// --- Epoch ---
function getEthBalanceModule(): Module | undefined {
  return modules.find((m) => m.id === "eth-balance") ?? modules[0];
}

function renderEpochBar() {
  const mod = getEthBalanceModule();
  if (!mod) return;

  const epochEl = $("#epoch-number");
  const countdownEl = $("#epoch-countdown");
  if (epochEl) epochEl.textContent = String(mod.currentEpoch);
  if (countdownEl) {
    countdownEl.textContent = formatEpochCountdown(
      mod.epochDurationSeconds,
      mod.currentEpoch,
    );
  }
}

function startEpochCountdown() {
  if (epochTimer) clearInterval(epochTimer);
  epochTimer = setInterval(() => {
    renderEpochBar();
  }, 1000);
}

// --- Claim View State Management ---

/** Toggle between connect prompt and claim form based on wallet state */
function updateClaimViewState() {
  const wallet = getWalletState();
  const connectPrompt = $("#connect-prompt");
  const formFields = $("#claim-form-fields");

  if (wallet.connected && wallet.address) {
    if (connectPrompt) hide(connectPrompt);
    if (formFields) show(formFields);
  } else {
    if (connectPrompt) show(connectPrompt);
    if (formFields) hide(formFields);
  }

  updateStepState();
}

/** Update step indicator based on current state */
function updateStepState() {
  if (isClaimInProgress) return; // Don't update during claim flow
  const wallet = getWalletState();
  const recipientInput = $("#recipient-input") as HTMLInputElement | null;
  const networkSelect = $("#network-select") as HTMLSelectElement | null;

  if (!wallet.connected || !wallet.address) {
    updateStepIndicator(1);
    return;
  }

  const hasRecipient = recipientInput && isValidAddress(recipientInput.value.trim());
  const hasNetwork = networkSelect && networkSelect.value !== "";

  if (hasRecipient && hasNetwork) {
    updateStepIndicator(2);
  } else {
    updateStepIndicator(2);
  }
}

// --- Wallet ---
function setupWalletListeners() {
  const connectBtn = $("#connect-wallet-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", handleConnectWallet);
  }

  onWalletChange(renderWalletStatus);
}

async function handleConnectWallet() {
  const btn = $("#connect-wallet-btn");
  clearMessage($("#wallet-messages"));

  if (!isMetaMaskAvailable()) {
    showMessage(
      $("#wallet-messages"),
      "MetaMask not detected. Please install MetaMask to connect your wallet.",
      "error",
    );
    return;
  }

  setLoading(btn, true);
  try {
    await connectWallet();
    renderWalletStatus(getWalletState());
    showToast("Wallet connected", "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showMessage($("#wallet-messages"), msg, "error");
  } finally {
    setLoading(btn, false);
  }
}

function renderWalletStatus(state: ReturnType<typeof getWalletState>) {
  const connectBtn = $("#connect-wallet-btn");
  const statusEl = $("#wallet-status");

  if (!state.connected || !state.address) {
    if (connectBtn) show(connectBtn);
    if (statusEl) hide(statusEl);
    updateClaimButton();
    updateClaimViewState();
    return;
  }

  if (connectBtn) hide(connectBtn);
  if (statusEl) {
    statusEl.className = "wallet-status connected";
    const hasBal = state.balance !== null;
    const balStr = hasBal ? formatBalance(state.balance!) : "...";
    const sufficient = hasBal ? hasMinBalance(state.balance!) : false;
    const balClass = hasBal
      ? sufficient
        ? "sufficient"
        : "insufficient"
      : "";
    const checkMark = sufficient ? " [ok]" : " [insufficient]";

    statusEl.innerHTML = `
      <div>
        <span class="wallet-address">${truncateAddress(state.address)}</span>
        <span class="wallet-balance ${balClass}">${balStr} ETH${hasBal ? checkMark : ""}</span>
      </div>
      <button class="wallet-disconnect" id="disconnect-btn">disconnect</button>
    `;
    show(statusEl);

    const disconnectBtn = $("#disconnect-btn");
    if (disconnectBtn) {
      disconnectBtn.addEventListener("click", () => {
        disconnectWallet();
        renderWalletStatus(getWalletState());
        showToast("Wallet disconnected", "info");
      });
    }
  }

  // Auto-fill recipient
  const recipientInput = $("#recipient-input") as HTMLInputElement | null;
  if (recipientInput && !recipientInput.value) {
    recipientInput.value = state.address;
  }

  updateClaimButton();
  updateClaimViewState();
}

function updateClaimButton() {
  const btn = $("#claim-btn") as HTMLButtonElement | null;
  if (!btn) return;

  const wallet = getWalletState();
  const recipientInput = $("#recipient-input") as HTMLInputElement | null;
  const networkSelect = $("#network-select") as HTMLSelectElement | null;

  const hasWallet = wallet.connected && wallet.balance !== null;
  const hasRecipient =
    recipientInput && isValidAddress(recipientInput.value.trim());
  const hasNetwork = networkSelect && networkSelect.value !== "";

  btn.disabled = !(hasWallet && hasRecipient && hasNetwork) || isClaimInProgress;

  updateStepState();
}

// --- Form Listeners ---
function setupFormListeners() {
  const recipientInput = $("#recipient-input");
  const networkSelect = $("#network-select");
  const claimBtn = $("#claim-btn");
  const statusInput = $("#status-input");
  const statusBtn = $("#status-btn");

  if (recipientInput) {
    recipientInput.addEventListener("input", () => {
      updateClaimButton();
      validateRecipientField();
    });
  }

  if (networkSelect) {
    networkSelect.addEventListener("change", updateClaimButton);
  }

  if (claimBtn) {
    claimBtn.addEventListener("click", handleClaim);
  }

  if (statusBtn) {
    statusBtn.addEventListener("click", handleCheckStatus);
  }

  if (statusInput) {
    statusInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") handleCheckStatus();
    });
  }
}

/** Keyboard shortcuts: Enter to submit claim form */
function setupKeyboardShortcuts() {
  const claimFormCard = $("#claim-form-card");
  if (claimFormCard) {
    claimFormCard.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey) {
        const claimBtn = $("#claim-btn") as HTMLButtonElement | null;
        if (claimBtn && !claimBtn.disabled) {
          ke.preventDefault();
          handleClaim();
        }
      }
    });
  }
}

/** Event delegation for copy buttons */
function setupCopyDelegation() {
  document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const copyBtn = target.closest("[data-copy]") as HTMLElement | null;
    if (!copyBtn) return;

    const text = copyBtn.getAttribute("data-copy") ?? "";
    const success = await copyToClipboard(text);
    if (success) {
      copyBtn.classList.add("copied");
      showToast("Copied to clipboard", "success");
      setTimeout(() => copyBtn.classList.remove("copied"), 1500);
    }
  });
}

function validateRecipientField() {
  const input = $("#recipient-input") as HTMLInputElement | null;
  if (!input) return;
  const val = input.value.trim();
  if (val && !isValidAddress(val)) {
    input.style.borderColor = "var(--error)";
  } else {
    input.style.borderColor = "";
  }
}

// --- Claim (Real ZK Proof Flow) ---
async function handleClaim() {
  if (isClaimInProgress) return;

  const btn = $("#claim-btn");
  const msgContainer = $("#claim-messages");
  const resultContainer = $("#claim-result");
  const progressContainer = $("#claim-progress");

  clearMessage(msgContainer);
  if (resultContainer) resultContainer.innerHTML = "";
  hideProvingProgress(progressContainer);

  const wallet = getWalletState();
  const recipientInput = $("#recipient-input") as HTMLInputElement | null;
  const networkSelect = $("#network-select") as HTMLSelectElement | null;

  const recipient = recipientInput?.value.trim() ?? "";
  const targetNetwork = networkSelect?.value ?? "";

  // --- Validation ---
  if (!wallet.connected || !wallet.address) {
    showMessage(msgContainer, "Please connect your wallet first.", "error");
    return;
  }

  if (!isValidAddress(recipient)) {
    showMessage(msgContainer, "Invalid recipient address.", "error");
    return;
  }

  if (!targetNetwork) {
    showMessage(msgContainer, "Please select a target network.", "error");
    return;
  }

  if (wallet.balance && !hasMinBalance(wallet.balance)) {
    const minEth = Number(MIN_BALANCE_WEI) / 1e18;
    showMessage(
      msgContainer,
      `Insufficient ETH balance. You need at least ${minEth} ETH.`,
      "error",
    );
    return;
  }

  const mod = getEthBalanceModule();
  if (!mod) {
    showMessage(msgContainer, "No proof module available.", "error");
    return;
  }

  isClaimInProgress = true;
  setLoading(btn, true);

  try {
    const epoch = mod.currentEpoch;

    // --- Step 1: Sign domain message ---
    updateStepIndicator(2);
    showProvingProgress(progressContainer, "Signing domain message...", "Please confirm in MetaMask");

    let signature: string;
    try {
      signature = await signDomainMessage(epoch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("User denied") || msg.includes("rejected")) {
        showMessage(msgContainer, "Signature request was rejected.", "error");
      } else {
        showErrorWithHint(msgContainer, "Failed to sign message: " + msg, "Make sure MetaMask is unlocked and try again.");
      }
      return;
    }

    // --- Step 2: Fetch storage proof via wallet's own RPC provider ---
    updateStepIndicator(3);
    showProvingProgress(progressContainer, "Fetching storage proof...", "Querying Ethereum via your wallet's RPC");

    let storageProof;
    try {
      storageProof = await getStorageProof(wallet.address);
      console.log("[zk_faucet] Storage proof fetched:", {
        stateRoot: storageProof.stateRoot,
        blockNumber: storageProof.blockNumber,
        balance: storageProof.balance,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showErrorWithHint(
        msgContainer,
        "Failed to fetch storage proof: " + msg,
        "Could not reach the Ethereum RPC via your wallet. Check your connection and try again.",
      );
      return;
    }

    // --- Step 3: Fetch circuit artifact + generate ZK proof in browser ---
    updateStepIndicator(4);
    showProvingProgress(
      progressContainer,
      "Loading circuit artifact...",
      "Downloading the compiled circuit (~5 MB)",
    );

    let circuitArtifact;
    try {
      circuitArtifact = await api.getCircuitArtifact(mod.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showErrorWithHint(
        msgContainer,
        "Failed to load circuit: " + msg,
        "The circuit artifact could not be downloaded. Check your connection and try again.",
      );
      return;
    }

    let proofResult;
    try {
      const { generateProofInBrowser } = await import("./prove");
      proofResult = await generateProofInBrowser(
        circuitArtifact,
        storageProof,
        signature,
        wallet.address,
        epoch,
        (step, detail) => {
          showProvingProgress(progressContainer, step, detail);
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showErrorWithHint(
        msgContainer,
        "Proof generation failed: " + msg,
        "The ZK proof could not be generated in your browser. Try refreshing and submitting again.",
      );
      return;
    }

    // --- Step 4: Submit claim ---
    updateStepIndicator(5);
    showProvingProgress(progressContainer, "Submitting claim...", "Sending proof to the faucet");

    console.log("[zk_faucet] Submitting claim with publicInputs:", {
      stateRoot: proofResult.publicInputs.stateRoot,
      epoch: proofResult.publicInputs.epoch,
      minBalance: proofResult.publicInputs.minBalance,
      nullifier: proofResult.publicInputs.nullifier,
    });

    const result = await api.submitClaim({
      moduleId: mod.id,
      proof: proofResult.proof,
      publicInputs: proofResult.publicInputs,
      recipient,
      targetNetwork,
    });

    // --- Step 5: Success ---
    hideProvingProgress(progressContainer);

    const net = networks.find((n) => n.id === result.network);
    const explorerLink = net
      ? getExplorerTxUrl(net.explorerUrl, result.txHash)
      : "";

    if (resultContainer) {
      resultContainer.innerHTML = `
        ${successCheckHtml()}
        <div class="result-card success-glow">
          <div class="result-row">
            <span class="result-label">Status</span>
            <span class="result-value">${statusBadgeHtml("confirmed")}</span>
          </div>
          <div class="result-row">
            <span class="result-label">Claim ID</span>
            <span class="result-value">${escapeHtml(result.claimId)}${copyButtonHtml(result.claimId)}</span>
          </div>
          <div class="result-row">
            <span class="result-label">Amount</span>
            <span class="result-value text-accent">${formatWei(result.amount)}</span>
          </div>
          <div class="result-row">
            <span class="result-label">Tx Hash</span>
            <span class="result-value">
              ${explorerLink ? externalLinkHtml(explorerLink, truncateAddress(result.txHash)) : escapeHtml(result.txHash)}${copyButtonHtml(result.txHash)}
            </span>
          </div>
          <div class="result-row">
            <span class="result-label">Network</span>
            <span class="result-value">${escapeHtml(net?.name ?? result.network)}</span>
          </div>
        </div>
      `;

      scrollToElement(resultContainer);
    }

    showToast("Claim successful!", "success");
  } catch (err) {
    hideProvingProgress(progressContainer);
    if (err instanceof ApiRequestError) {
      const friendly = getFriendlyError(err.code, err.message, mod?.epochDurationSeconds);
      showErrorWithHint(msgContainer, friendly.message, friendly.hint);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      showErrorWithHint(
        msgContainer,
        msg,
        "If this persists, please try again or check the server status.",
      );
    }
  } finally {
    isClaimInProgress = false;
    setLoading(btn, false);
    hideProvingProgress(progressContainer);
    updateStepState();
  }
}

// --- Status Check ---
async function handleCheckStatus() {
  const btn = $("#status-btn");
  const input = $("#status-input") as HTMLInputElement | null;
  const msgContainer = $("#status-messages");
  const resultContainer = $("#status-result");

  clearMessage(msgContainer);
  if (resultContainer) resultContainer.innerHTML = "";

  const claimId = input?.value.trim() ?? "";
  if (!claimId) {
    showMessage(msgContainer, "Please enter a claim ID.", "error");
    return;
  }

  setLoading(btn, true);

  try {
    const result = await api.getStatus(claimId);

    const net = networks.find((n) => n.id === result.network);
    const explorerLink =
      net && result.txHash
        ? getExplorerTxUrl(net.explorerUrl, result.txHash)
        : "";

    if (resultContainer) {
      resultContainer.innerHTML = `
        <div class="result-card${result.status === "confirmed" ? " success-glow" : ""}">
          <div class="result-row">
            <span class="result-label">Status</span>
            <span class="result-value">${statusBadgeHtml(result.status)}</span>
          </div>
          <div class="result-row">
            <span class="result-label">Claim ID</span>
            <span class="result-value">${escapeHtml(result.claimId)}${copyButtonHtml(result.claimId)}</span>
          </div>
          ${
            result.txHash
              ? `<div class="result-row">
              <span class="result-label">Tx Hash</span>
              <span class="result-value">
                ${explorerLink ? externalLinkHtml(explorerLink, truncateAddress(result.txHash)) : escapeHtml(result.txHash)}${copyButtonHtml(result.txHash)}
              </span>
            </div>`
              : ""
          }
          ${
            result.network
              ? `<div class="result-row">
              <span class="result-label">Network</span>
              <span class="result-value">${escapeHtml(net?.name ?? result.network)}</span>
            </div>`
              : ""
          }
        </div>
      `;

      scrollToElement(resultContainer);
    }
  } catch (err) {
    if (err instanceof ApiRequestError) {
      const friendly = getFriendlyError(err.code, err.message);
      showErrorWithHint(msgContainer, friendly.message, friendly.hint);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      showErrorWithHint(
        msgContainer,
        msg,
        "If this persists, please try again or check the server status.",
      );
    }
  } finally {
    setLoading(btn, false);
  }
}

// --- Info View ---
function renderInfoView() {
  renderInfoNetworks();
  renderInfoEpoch();
}

function renderInfoNetworks() {
  const container = $("#info-networks");
  if (!container) return;

  if (networks.length === 0) {
    container.innerHTML =
      '<p class="text-sm text-muted">No networks loaded.</p>';
    return;
  }

  container.innerHTML = networks
    .map(
      (n) => `
    <div class="network-item ${n.enabled ? "" : "network-disabled"}">
      <span class="network-name">${escapeHtml(n.name)} (chain ${n.chainId})</span>
      <span class="network-amount">${formatWei(n.dispensationWei)}</span>
    </div>
  `,
    )
    .join("");
}

function renderInfoEpoch() {
  const container = $("#info-epoch");
  if (!container) return;

  const mod = getEthBalanceModule();
  if (!mod) {
    container.innerHTML =
      '<p class="text-sm text-muted">No module data available.</p>';
    return;
  }

  const durationHrs = mod.epochDurationSeconds / 3600;

  container.innerHTML = `
    <div class="info-grid">
      <div class="info-item">
        <span class="label">Module</span>
        <span class="value">${escapeHtml(mod.name)}</span>
      </div>
      <div class="info-item">
        <span class="label">Current Epoch</span>
        <span class="value">${mod.currentEpoch}</span>
      </div>
      <div class="info-item">
        <span class="label">Duration</span>
        <span class="value">${durationHrs}h</span>
      </div>
      <div class="info-item">
        <span class="label">Resets in</span>
        <span class="value" id="info-epoch-countdown">${formatEpochCountdown(mod.epochDurationSeconds, mod.currentEpoch)}</span>
      </div>
    </div>
  `;
}
