// DOM manipulation helpers and rendering functions

export function $(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

export function $all(selector: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(selector);
}

export function show(el: HTMLElement | null) {
  if (el) el.classList.remove("hidden");
}

export function hide(el: HTMLElement | null) {
  if (el) el.classList.add("hidden");
}

export function setLoading(el: HTMLElement | null, loading: boolean) {
  if (!el) return;
  if (loading) {
    el.classList.add("loading");
    el.setAttribute("disabled", "true");
  } else {
    el.classList.remove("loading");
    el.removeAttribute("disabled");
  }
}

export function showMessage(
  container: HTMLElement | null,
  message: string,
  type: "success" | "error" | "info",
) {
  if (!container) return;
  container.innerHTML = `<div class="message message-${type}">${escapeHtml(message)}</div>`;
  show(container);
}

/** Show an error message with an actionable hint (#12) */
export function showErrorWithHint(
  container: HTMLElement | null,
  message: string,
  hint: string,
) {
  if (!container) return;
  container.innerHTML = `<div class="message message-error">${escapeHtml(message)}<span class="error-hint">${escapeHtml(hint)}</span></div>`;
  show(container);
}

export function clearMessage(container: HTMLElement | null) {
  if (!container) return;
  container.innerHTML = "";
}

export function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function truncateAddress(address: string): string {
  return address.slice(0, 6) + "..." + address.slice(-4);
}

export function formatWei(wei: string): string {
  const eth = Number(BigInt(wei)) / 1e18;
  return eth.toFixed(4) + " ETH";
}

export function getExplorerTxUrl(explorerUrl: string, txHash: string): string {
  return `${explorerUrl}/tx/${txHash}`;
}

export function statusBadgeHtml(status: "pending" | "confirmed" | "failed"): string {
  const labels: Record<string, string> = {
    pending: "Pending",
    confirmed: "Confirmed",
    failed: "Failed",
  };
  return `<span class="badge badge-${status}">${labels[status] ?? status}</span>`;
}

export function formatEpochCountdown(epochDurationSeconds: number, currentEpoch: number): string {
  const epochStartMs = currentEpoch * epochDurationSeconds * 1000;
  const epochEndMs = epochStartMs + epochDurationSeconds * 1000;
  const remainingMs = epochEndMs - Date.now();

  if (remainingMs <= 0) return "Epoch ended";

  const hours = Math.floor(remainingMs / 3600000);
  const minutes = Math.floor((remainingMs % 3600000) / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

/** Set the active navigation tab */
export function setActiveNav(view: string) {
  $all("[data-nav]").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-nav") === view);
  });
}

/** Navigate between views */
export function showView(view: string) {
  $all("[data-view]").forEach((el) => {
    el.classList.toggle("hidden", el.getAttribute("data-view") !== view);
  });
  setActiveNav(view);
}

// --- Toast notifications (#10) ---

export function showToast(message: string, type: "success" | "info" | "error" = "info") {
  const container = $("#toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Auto-remove after animation completes
  setTimeout(() => {
    toast.remove();
  }, 3100);
}

// --- Copy to clipboard (#9) ---

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/** Create a copy button element with click handler */
export function copyButtonHtml(textToCopy: string): string {
  // We use a data attribute; the click handler is wired up in main.ts via event delegation
  const encoded = escapeHtml(textToCopy);
  return `<button class="copy-btn" data-copy="${encoded}" title="Copy to clipboard">&#x2398;</button>`;
}

// --- Auto-scroll (#8) ---

export function scrollToElement(el: HTMLElement | null) {
  if (!el) return;
  setTimeout(() => {
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 100);
}

// --- External link with icon (#13) ---

export function externalLinkHtml(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="external-link">${escapeHtml(label)}<svg class="external-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
}

// --- Success checkmark SVG (#4) ---

export function successCheckHtml(): string {
  return `<div class="success-check"><svg viewBox="0 0 52 52"><circle class="check-circle" cx="26" cy="26" r="25"/><path class="check-mark" d="M14.1 27.2l7.1 7.2 16.7-16.8"/></svg></div>`;
}

// --- Step indicator logic (#2) ---

export function updateStepIndicator(currentStep: 1 | 2 | 3 | 4 | 5) {
  for (let i = 1; i <= 5; i++) {
    const stepEl = document.querySelector(`[data-step="${i}"]`);
    if (!stepEl) continue;

    stepEl.classList.remove("active", "completed", "proving");
    if (i < currentStep) {
      stepEl.classList.add("completed");
    } else if (i === currentStep) {
      stepEl.classList.add("active");
    }
  }

  // Update connectors
  for (let i = 1; i <= 4; i++) {
    const connector = document.querySelector(`[data-connector="${i}"]`);
    if (!connector) continue;
    connector.classList.toggle("active", i < currentStep);
  }
}

/** Show a proving progress overlay */
export function showProvingProgress(container: HTMLElement | null, step: string, detail?: string) {
  if (!container) return;
  container.innerHTML = `
    <div class="proving-progress">
      <div class="proving-spinner"></div>
      <div class="proving-step">${escapeHtml(step)}</div>
      ${detail ? `<div class="proving-detail">${escapeHtml(detail)}</div>` : ""}
    </div>
  `;
  show(container);
}

/** Hide proving progress */
export function hideProvingProgress(container: HTMLElement | null) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
}

// --- Friendly error messages (#12) ---

interface FriendlyError {
  message: string;
  hint: string;
}

export function getFriendlyError(code: string, originalMessage: string, epochDurationSeconds?: number): FriendlyError {
  const durationHrs = epochDurationSeconds ? Math.round(epochDurationSeconds / 3600) : 24;

  const errorMap: Record<string, FriendlyError> = {
    ALREADY_CLAIMED: {
      message: "You've already claimed this epoch.",
      hint: `Each wallet can claim once per epoch. Try again after the epoch resets (every ${durationHrs}h).`,
    },
    INVALID_PROOF: {
      message: "The ZK proof could not be verified.",
      hint: "Try reconnecting your wallet and submitting again. If the issue persists, your wallet's balance may have changed.",
    },
    INSUFFICIENT_BALANCE: {
      message: "Your ETH balance is too low.",
      hint: "You need a minimum ETH balance on the origin chain to claim testnet funds.",
    },
    RATE_LIMITED: {
      message: "Too many requests.",
      hint: "Please wait a moment before trying again.",
    },
    NETWORK_UNAVAILABLE: {
      message: "The selected network is currently unavailable.",
      hint: "Try a different target network, or check back later.",
    },
    FAUCET_DRAINED: {
      message: "The faucet is temporarily out of funds.",
      hint: "The faucet wallet needs to be refilled. Please try again later.",
    },
  };

  if (errorMap[code]) {
    return errorMap[code];
  }

  return {
    message: originalMessage || `Error: ${code}`,
    hint: "If this persists, please try again or check the server status.",
  };
}
