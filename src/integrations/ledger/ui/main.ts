// ─── SafeSwarm × Ledger — Browser Entry Point ───
// Glues DMK, signer, and WS bridge together for the test UI.

import { initDMK, discoverDevices, stopDiscovering, connectDevice, disconnectDevice, getActiveSession } from "../dmk";
import { createSigner, requestSignature, signTypedData, getAddress } from "../signer";
import type { TypedData } from "../signer";
import type { ApprovalRequest, ApprovalResult, DeviceStatus, BridgeMessage } from "../types";

// ─── DOM elements ───
const deviceStatusEl  = document.getElementById("device-status")!;
const deviceAddressEl = document.getElementById("device-address")!;
const connectBtn      = document.getElementById("connect-btn")! as HTMLButtonElement;
const disconnectBtn   = document.getElementById("disconnect-btn")! as HTMLButtonElement;
const approvalsEl     = document.getElementById("approvals-container")!;
const logContainer    = document.getElementById("log-container")!;
const mockTradeBtn    = document.getElementById("mock-trade-btn")! as HTMLButtonElement;
const bridgeDot       = document.getElementById("bridge-dot")!;
const bridgeLabel     = document.getElementById("bridge-label")!;
const swapAmountInput = document.getElementById("swap-amount")! as HTMLInputElement;
const quoteBtn        = document.getElementById("quote-btn")! as HTMLButtonElement;
const quoteResultEl   = document.getElementById("quote-result")!;
const intentInput     = document.getElementById("intent-input")! as HTMLInputElement;
const intentBtn       = document.getElementById("intent-btn")! as HTMLButtonElement;
const intentStatusEl  = document.getElementById("intent-status")!;
const agentPanel      = document.getElementById("agent-panel")!;
const agentResultEl   = document.getElementById("agent-result")!;
const providerGroqBtn = document.getElementById("provider-groq")! as HTMLButtonElement;
const provider0gBtn   = document.getElementById("provider-0g")! as HTMLButtonElement;
const providerStatusEl = document.getElementById("provider-status")!;
const onboardingScreen = document.getElementById("onboarding-screen")!;
const deploySafeBtn   = document.getElementById("deploy-safe-btn")! as HTMLButtonElement;
const onboardStatusEl = document.getElementById("onboard-status")!;
const safeStatusEl    = document.getElementById("safe-status")!;
const safeStatusText  = document.getElementById("safe-status-text")!;
const limitButtons    = document.querySelectorAll(".limit-btn");
const settingsSection = document.getElementById("settings-section")!;
const currentLimitEl  = document.getElementById("current-limit")!;
const newLimitInput   = document.getElementById("new-limit-input")! as HTMLInputElement;
const updateLimitBtn  = document.getElementById("update-limit-btn")! as HTMLButtonElement;
const limitStatusEl   = document.getElementById("limit-status")!;
const depositSection  = document.getElementById("deposit-section")!;
const depositToken    = document.getElementById("deposit-token")! as HTMLSelectElement;
const depositAmount   = document.getElementById("deposit-amount")! as HTMLInputElement;
const depositBtn      = document.getElementById("deposit-btn")! as HTMLButtonElement;
const depositStatusEl = document.getElementById("deposit-status")!;
const safeBalancesEl  = document.getElementById("safe-balances")!;

// ─── State ───
let deviceStatus: DeviceStatus = "disconnected";
let ws: WebSocket | null = null;
let hasApprovals = false;
let fullWalletAddress: string | null = null;
let currentSafeAddress: string | null = null;
let selectedLimit = 100;

const BRIDGE_URL = "ws://localhost:3001/ws";
const BRIDGE_HTTP = "http://localhost:3001";

// ─── Logging ───
function log(msg: string): void {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  entry.innerHTML = `<span class="log-time">${time}</span> <span class="log-msg">${msg}</span>`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// ─── Device status ───
function setDeviceStatus(status: DeviceStatus): void {
  deviceStatus = status;
  deviceStatusEl.textContent = status;
  deviceStatusEl.className = `status-badge status-${status}`;

  connectBtn.style.display =
    status === "disconnected" ? "block" : "none";
  disconnectBtn.style.display =
    ["connected", "ready", "signing", "approved", "rejected"].includes(status)
      ? "block"
      : "none";
}

// ─── Connect to Ledger ───
connectBtn.addEventListener("click", async () => {
  try {
    setDeviceStatus("scanning");
    log("Starting device discovery…");
    connectBtn.disabled = true;

    log("Initializing DMK…");
    initDMK();
    log("DMK initialized ✓");

    discoverDevices(
      async (device) => {
        log(`Device emitted by DMK: ${JSON.stringify(Object.keys(device))}`);
        log(`Device id: ${(device as any).id}`);
        log(`Device deviceModel: ${JSON.stringify((device as any).deviceModel)}`);
        log(`Device type: ${(device as any).type}`);
        log(`Current deviceStatus: ${deviceStatus}`);

        if (deviceStatus !== "scanning" && deviceStatus !== "disconnected") {
          log("Ignoring — already connected");
          return;
        }

        const modelName = (device as any).deviceModel?.productName
          ?? (device as any).deviceModel?.model
          ?? (device as any).name
          ?? "Ledger device";
        log(`Found device: ${modelName}`);
        setDeviceStatus("connected");

        // Stop scanning once we have a device
        stopDiscovering();
        log("Stopped discovery ✓");

        try {
          log(`Calling connectDevice with id: ${(device as any).id}…`);
          const sessionId = await connectDevice((device as any).id);
          log(`Session obtained: ${sessionId}`);

          // Get address from device
          log("Creating signer…");
          const signer = createSigner(sessionId);
          log("Requesting address from device…");
          const address = await getAddress(signer);
          fullWalletAddress = address;
          deviceAddressEl.textContent = `${address.slice(0, 8)}…${address.slice(-6)}`;
          log(`Address: ${address}`);

          setDeviceStatus("ready");
          log("Device is READY ✓");

          // Check Safe status after Ledger connects
          checkSafeStatus(address);
        } catch (err: any) {
          log(`❌ Connection error: ${err.message}`);
          console.error("Connection error:", err);
          setDeviceStatus("disconnected");
          connectBtn.disabled = false;
        }
      },
      (err) => {
        log(`❌ Discovery error: ${err.message}`);
        console.error("Discovery error:", err);
        setDeviceStatus("disconnected");
        connectBtn.disabled = false;
      }
    );
  } catch (err: any) {
    log(`❌ Init error: ${err.message}`);
    console.error("Init error:", err);
    setDeviceStatus("disconnected");
    connectBtn.disabled = false;
  }
});

// ─── Disconnect ───
disconnectBtn.addEventListener("click", async () => {
  await disconnectDevice();
  setDeviceStatus("disconnected");
  deviceAddressEl.textContent = "—";
  fullWalletAddress = null;
  currentSafeAddress = null;
  safeStatusEl.style.display = "none";
  depositSection.style.display = "none";
  settingsSection.style.display = "none";
  connectBtn.disabled = false;
  log("Device disconnected");
});

// ─── Safe Onboarding ───
async function checkSafeStatus(address: string): Promise<void> {
  safeStatusEl.style.display = "block";
  safeStatusText.textContent = "Safe: detecting...";
  try {
    const resp = await fetch(`${BRIDGE_HTTP}/check-safe?address=${address}`);
    const data = await resp.json();
    if (data.hasSafe) {
      currentSafeAddress = data.safeAddress;
      selectedLimit = data.spendingLimitUSD || 100;
      currentLimitEl.textContent = `$${selectedLimit}`;
      safeStatusText.innerHTML = `Safe: <span style="cursor:pointer;text-decoration:underline" title="Click to copy" onclick="navigator.clipboard.writeText('${data.safeAddress}')">${data.safeAddress.slice(0, 8)}...${data.safeAddress.slice(-6)}</span> ($${selectedLimit} auto-limit)`;
      settingsSection.style.display = "block";
      depositSection.style.display = "block";
      refreshSafeBalances(data.safeAddress);
      log(`Safe account detected: ${data.safeAddress}`);
    } else {
      safeStatusText.textContent = "Safe: not deployed";
      safeStatusText.style.color = "var(--text-dim)";
      safeStatusEl.style.borderColor = "var(--border)";
      safeStatusEl.style.background = "transparent";
      showOnboarding();
    }
  } catch (err: any) {
    safeStatusText.textContent = "Safe: check failed";
    log(`Safe check error: ${err.message}`);
  }
}

function showOnboarding(): void {
  onboardingScreen.style.display = "flex";
}

function hideOnboarding(): void {
  onboardingScreen.style.display = "none";
}

// Limit button selection
limitButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    limitButtons.forEach(b => {
      (b as HTMLElement).classList.remove("btn-primary");
      (b as HTMLElement).classList.add("btn-secondary");
    });
    (btn as HTMLElement).classList.remove("btn-secondary");
    (btn as HTMLElement).classList.add("btn-primary");
    selectedLimit = Number((btn as HTMLElement).dataset.limit);
  });
});

// Deploy Safe button
deploySafeBtn.addEventListener("click", async () => {
  if (!fullWalletAddress) {
    onboardStatusEl.textContent = "Connect Ledger first";
    return;
  }

  deploySafeBtn.disabled = true;
  onboardStatusEl.textContent = "Deploying your Safe account on Sepolia...";

  try {
    const resp = await fetch(`${BRIDGE_HTTP}/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ledgerAddress: fullWalletAddress, spendingLimitUSD: selectedLimit }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Onboarding failed");

    currentSafeAddress = data.safeAddress;
    onboardStatusEl.innerHTML = `Safe deployed! Use the Deposit section to fund it.`;
    log(`Safe deployed: ${data.safeAddress}`);

    // Update Safe status display
    safeStatusText.innerHTML = `Safe: <span style="cursor:pointer;text-decoration:underline" title="Click to copy" onclick="navigator.clipboard.writeText('${data.safeAddress}')">${data.safeAddress.slice(0, 8)}...${data.safeAddress.slice(-6)}</span> ($${selectedLimit} auto-limit)`;
    safeStatusText.style.color = "#0f8";
    safeStatusEl.style.borderColor = "rgba(0,255,128,0.2)";
    safeStatusEl.style.background = "rgba(0,255,128,0.08)";
    depositSection.style.display = "block";
    settingsSection.style.display = "block";
    currentLimitEl.textContent = `$${selectedLimit}`;
    refreshSafeBalances(data.safeAddress);

    setTimeout(hideOnboarding, 1500);
  } catch (err: any) {
    onboardStatusEl.textContent = `Error: ${err.message}`;
    log(`Onboard error: ${err.message}`);
  } finally {
    deploySafeBtn.disabled = false;
  }
});

// ─── Update Spending Limit (Ledger-signed) ───
updateLimitBtn.addEventListener("click", async () => {
  const newLimit = Number(newLimitInput.value);
  if (!newLimit || newLimit <= 0) {
    limitStatusEl.textContent = "Enter a valid amount";
    limitStatusEl.style.color = "var(--red)";
    return;
  }
  if (!fullWalletAddress || !currentSafeAddress) {
    limitStatusEl.textContent = "Connect Ledger and deploy Safe first";
    limitStatusEl.style.color = "var(--red)";
    return;
  }
  if (deviceStatus !== "ready") {
    limitStatusEl.textContent = "Ledger not ready";
    limitStatusEl.style.color = "var(--red)";
    return;
  }
  const sessionId = getActiveSession();
  if (!sessionId) {
    limitStatusEl.textContent = "No active Ledger session";
    limitStatusEl.style.color = "var(--red)";
    return;
  }

  updateLimitBtn.disabled = true;
  limitStatusEl.textContent = "Preparing transaction...";
  limitStatusEl.style.color = "var(--text-dim)";
  log(`Updating spending limit to $${newLimit}...`);

  try {
    const { ethers } = await import("ethers");

    // Step 1: Get unsigned tx from backend
    const prepRes = await fetch(`${BRIDGE_HTTP}/prepare-limit-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newLimitUSD: newLimit, ledgerAddress: fullWalletAddress }),
    });
    const prepData = await prepRes.json();
    if (!prepRes.ok) throw new Error(prepData.error || "Failed to prepare tx");

    const { unsignedTx } = prepData;

    // Step 2: Get nonce + gas for the Ledger EOA
    const nonceRes = await fetch(`${BRIDGE_HTTP}/nonce/${fullWalletAddress}`);
    const { nonce, maxFeePerGas, maxPriorityFeePerGas } = await nonceRes.json();

    // Step 3: Sign on Ledger
    limitStatusEl.textContent = "Sign on Ledger to update limit...";
    log("Sign Safe tx on Ledger...");
    setDeviceStatus("signing");

    const tx = ethers.Transaction.from({
      to: unsignedTx.to,
      data: unsignedTx.data,
      value: 0n,
      chainId: 11155111,
      gasLimit: unsignedTx.gasLimit,
      type: 2,
      maxFeePerGas: BigInt(maxFeePerGas),
      maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
      nonce,
    });

    const signer = createSigner(sessionId);
    const sig = await requestSignature(signer, tx.unsignedSerialized, (s) => log(`  ↳ ${s}`));

    const signedTx = tx.clone();
    signedTx.signature = ethers.Signature.from(sig);
    setDeviceStatus("ready");

    // Step 4: Broadcast
    limitStatusEl.textContent = "Broadcasting...";
    log("Broadcasting limit update tx...");

    const broadcastRes = await fetch(`${BRIDGE_HTTP}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedTx: signedTx.serialized }),
    });
    const broadcastData = await broadcastRes.json();
    if (!broadcastRes.ok) throw new Error(broadcastData.error || "Broadcast failed");

    log(`Limit update tx broadcast: ${broadcastData.txHash}`);
    limitStatusEl.textContent = "Confirming on-chain...";

    // Step 5: Finalize — update 0G Storage + OrchestraPolicy
    const finalRes = await fetch(`${BRIDGE_HTTP}/finalize-limit-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newLimitUSD: newLimit, ledgerAddress: fullWalletAddress, txHash: broadcastData.txHash }),
    });
    const finalData = await finalRes.json();
    if (!finalRes.ok) throw new Error(finalData.error || "Finalize failed");

    // Step 6: Update UI
    selectedLimit = newLimit;
    currentLimitEl.textContent = `$${newLimit}`;
    safeStatusText.innerHTML = `Safe: <span style="cursor:pointer;text-decoration:underline" title="Click to copy" onclick="navigator.clipboard.writeText('${currentSafeAddress}')">${currentSafeAddress!.slice(0, 8)}...${currentSafeAddress!.slice(-6)}</span> ($${newLimit} auto-limit)`;
    newLimitInput.value = "";
    limitStatusEl.innerHTML = `Updated! <a href="${broadcastData.explorerUrl}" target="_blank" style="color:var(--accent)">view tx</a>`;
    limitStatusEl.style.color = "var(--green)";
    log(`Spending limit updated to $${newLimit}`);
    setTimeout(() => { limitStatusEl.textContent = ""; }, 8000);
  } catch (err: any) {
    limitStatusEl.textContent = `Error: ${err.message}`;
    limitStatusEl.style.color = "var(--red)";
    log(`Limit update error: ${err.message}`);
    setDeviceStatus("ready");
  } finally {
    updateLimitBtn.disabled = false;
  }
});

// ─── Safe Deposit ───
async function refreshSafeBalances(safeAddr: string): Promise<void> {
  try {
    const resp = await fetch(`${BRIDGE_HTTP}/safe-balances?address=${safeAddr}`);
    const b = await resp.json();
    safeBalancesEl.innerHTML = `Safe balances: <strong>${Number(b.eth).toFixed(4)}</strong> ETH | <strong>${Number(b.usdc).toFixed(2)}</strong> USDC | <strong>${Number(b.weth).toFixed(4)}</strong> WETH`;
  } catch {
    safeBalancesEl.textContent = "Could not fetch Safe balances";
  }
}

const USDC_SEPOLIA_ADDR = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const WETH_SEPOLIA_ADDR = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

depositBtn.addEventListener("click", async () => {
  if (!fullWalletAddress || !currentSafeAddress) {
    depositStatusEl.textContent = "Connect Ledger and deploy Safe first";
    return;
  }

  const token = depositToken.value;
  const amount = depositAmount.value.trim();
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    depositStatusEl.textContent = "Enter a valid amount";
    return;
  }

  depositBtn.disabled = true;
  depositStatusEl.textContent = "Preparing transaction...";

  try {
    const { ethers } = await import("ethers");

    const nonceResp = await fetch(`${BRIDGE_HTTP}/nonce/${fullWalletAddress}`);
    const nonceData = await nonceResp.json();
    const maxFeePerGas = BigInt(nonceData.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(nonceData.maxPriorityFeePerGas);

    const sessionId = getActiveSession();
    if (!sessionId) throw new Error("No active Ledger session");
    const signer = createSigner(sessionId);

    let tx: ReturnType<typeof ethers.Transaction.from>;

    if (token === "eth") {
      const value = ethers.parseEther(amount);
      depositStatusEl.textContent = "Sign ETH transfer on Ledger...";
      log(`Depositing ${amount} ETH to Safe...`);

      tx = ethers.Transaction.from({
        to: currentSafeAddress,
        value,
        nonce: nonceData.nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: 21000,
        chainId: 11155111,
        type: 2,
      });
    } else {
      const tokenAddr = token === "usdc" ? USDC_SEPOLIA_ADDR : WETH_SEPOLIA_ADDR;
      const decimals = token === "usdc" ? 6 : 18;
      const iface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
      const data = iface.encodeFunctionData("transfer", [
        currentSafeAddress,
        ethers.parseUnits(amount, decimals),
      ]);

      depositStatusEl.textContent = `Sign ${token.toUpperCase()} transfer on Ledger...`;
      log(`Depositing ${amount} ${token.toUpperCase()} to Safe...`);

      tx = ethers.Transaction.from({
        to: tokenAddr,
        value: 0n,
        data,
        nonce: nonceData.nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: 80000,
        chainId: 11155111,
        type: 2,
      });
    }

    setDeviceStatus("signing");
    const sig = await requestSignature(signer, tx.unsignedSerialized, (s) => log(`  ↳ ${s}`));

    const signedTx = tx.clone();
    signedTx.signature = ethers.Signature.from(sig);
    setDeviceStatus("ready");

    depositStatusEl.textContent = "Broadcasting...";
    const broadcastResp = await fetch(`${BRIDGE_HTTP}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedTx: signedTx.serialized }),
    });
    const result = await broadcastResp.json();
    if (!broadcastResp.ok) throw new Error(result.error);

    depositStatusEl.innerHTML = `Deposited ${amount} ${token.toUpperCase()} — <a href="${result.explorerUrl}" target="_blank" style="color:var(--accent)">view tx</a>`;
    log(`${token.toUpperCase()} deposit: ${result.txHash}`);

    // Refresh balances after deposit
    setTimeout(() => refreshSafeBalances(currentSafeAddress!), 5000);

  } catch (err: any) {
    depositStatusEl.textContent = `Error: ${err.message}`;
    log(`Deposit error: ${err.message}`);
  } finally {
    depositBtn.disabled = false;
  }
});

// ─── WebSocket bridge ───
function connectBridge(): void {
  ws = new WebSocket(BRIDGE_URL);

  ws.onopen = () => {
    bridgeDot.classList.add("connected");
    bridgeLabel.textContent = "bridge: connected";
    log("Bridge connected");
  };

  ws.onmessage = (event) => {
    try {
      const msg: BridgeMessage = JSON.parse(event.data);
      if (msg.type === "APPROVAL_REQUIRED") {
        log(`Approval request: ${msg.payload.summary}`);
        renderApprovalCard(msg.payload);
      }
    } catch {
      log("Bad message from bridge");
    }
  };

  ws.onclose = () => {
    bridgeDot.classList.remove("connected");
    bridgeLabel.textContent = "bridge: disconnected";
    log("Bridge disconnected — reconnecting in 3s…");
    setTimeout(connectBridge, 3000);
  };

  ws.onerror = () => {
    log("Bridge connection error");
  };
}

// ─── Render approval card ───
function renderApprovalCard(request: ApprovalRequest): void {
  // Remove empty state if present
  if (!hasApprovals) {
    approvalsEl.innerHTML = "";
    hasApprovals = true;
  }

  const card = document.createElement("div");
  card.className = "approval-card";
  card.id = `trade-${request.tradeId}`;

  const txPreview = request.unsignedTxHex.length > 40
    ? `${request.unsignedTxHex.slice(0, 20)}…${request.unsignedTxHex.slice(-20)}`
    : request.unsignedTxHex;

  card.innerHTML = `
    <div class="approval-header">
      <span class="risk-badge risk-${request.riskLevel}">${request.riskLevel.replace("_", " ")}</span>
      <span class="trade-time">${new Date(request.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</span>
    </div>
    <p class="trade-summary">${request.summary}</p>
    <p class="trade-tx">${txPreview}</p>
    <div class="approval-actions">
      <button class="btn btn-sign" data-trade-id="${request.tradeId}">Sign on Device</button>
    </div>
    <div class="approval-status" id="status-${request.tradeId}"></div>
  `;

  card.querySelector(".btn-sign")!.addEventListener("click", () => {
    log("Sign button clicked!");
    handleSign(request, card);
  });

  approvalsEl.prepend(card);
}

// ─── Handle signing on device ───
async function handleSign(request: ApprovalRequest, card: HTMLElement): Promise<void> {
  log(`handleSign called — deviceStatus = ${deviceStatus}`);
  if (deviceStatus !== "ready") {
    log("⚠ Device not ready — connect first");
    return;
  }

  const statusEl = card.querySelector(".approval-status")!;
  const signBtn = card.querySelector(".btn-sign") as HTMLButtonElement;

  try {
    setDeviceStatus("signing");
    signBtn.disabled = true;
    statusEl.textContent = "Check your Ledger device…";
    statusEl.className = "approval-status status-pending";
    log(`Signing ${request.tradeId.slice(0, 8)}… — check device`);

    const sessionId = getActiveSession();
    if (!sessionId) throw new Error("No active session");

    const signer = createSigner(sessionId);
    const signature = await requestSignature(
      signer,
      request.unsignedTxHex,
      (status) => {
        log(`  ↳ ${status}`);
        statusEl.textContent = status;
      }
    );

    // Approved
    setDeviceStatus("ready");
    statusEl.textContent = "✓ Approved";
    statusEl.className = "approval-status status-approved";
    card.className = "approval-card card-approved";
    log(`✓ Trade ${request.tradeId.slice(0, 8)}… approved — r=${signature.r.slice(0, 14)}…`);

    sendResult({ tradeId: request.tradeId, approved: true, signature });
  } catch (err: any) {
    setDeviceStatus("ready");
    statusEl.textContent = `✗ ${err.message}`;
    statusEl.className = "approval-status status-rejected";
    card.className = "approval-card card-rejected";
    signBtn.disabled = false;
    log(`✗ Trade ${request.tradeId.slice(0, 8)}… rejected: ${err.message}`);

    sendResult({ tradeId: request.tradeId, approved: false, error: err.message });
  }
}

// ─── Send result back to bridge ───
function sendResult(result: ApprovalResult): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "APPROVAL_RESULT", payload: result }));
  }
}

// ─── Mock trade trigger ───
mockTradeBtn.addEventListener("click", async () => {
  log("Triggering mock trade…");
  try {
    const res = await fetch(`${BRIDGE_HTTP}/mock-trade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Swap 0.5 ETH → ~1,247 USDC via Uniswap V3",
        riskLevel: "requires_approval",
      }),
    });
    const data = await res.json();
    log(`Mock trade queued: ${data.tradeId.slice(0, 12)}…`);
  } catch (err: any) {
    log(`Failed to trigger mock trade: ${err.message}`);
  }
});

// ─── Intent flow (AI agents) ───
intentBtn.addEventListener("click", async () => {
  const message = intentInput.value.trim();
  if (!message) return;

  if (!fullWalletAddress) {
    log("⚠ Connect Ledger first");
    return;
  }

  intentBtn.disabled = true;
  intentStatusEl.textContent = "Running agent pipeline…";
  intentStatusEl.style.color = "var(--text-dim)";
  agentPanel.style.display = "none";
  log(`Intent: "${message}"`);
  log("Running Planner → Gatekeeper pipeline…");

  try {
    const res = await fetch(`${BRIDGE_HTTP}/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, walletAddress: fullWalletAddress }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.status === "no_action") {
      log(`Agents found no action needed: ${data.reasoning}`);
      intentStatusEl.textContent = "No action needed.";
      return;
    }

    // Show agent reasoning panel
    const verdictBadge = `<span class="badge badge-verdict-${data.assessment.verdict}">${data.assessment.verdict.replace("_", " ")}</span>`;
    agentResultEl.innerHTML = `
      <div class="agent-step">
        <div class="agent-step-label">Planner</div>
        <div class="agent-step-text">${data.agentReasoning.planner}</div>
      </div>
      <div class="agent-step">
        <div class="agent-step-label">Plan</div>
        <div class="agent-step-text">${data.plan.summary} — $${data.plan.totalEstimatedValueUsd}</div>
      </div>
      <div class="agent-step">
        <div class="agent-step-label">Gatekeeper</div>
        <div class="agent-step-text">${data.agentReasoning.gatekeeper}</div>
      </div>
      <div class="agent-step">
        <div class="agent-step-label">Verdict</div>
        <div class="agent-step-text">
          ${verdictBadge}
          risk score: ${data.assessment.riskScore}/100
          ${data.assessment.requiresLedger ? "— Ledger approval required" : ""}
        </div>
      </div>
    `;
    agentPanel.style.display = "block";

    log(`Plan: ${data.plan.summary}`);
    log(`Verdict: ${data.assessment.verdict} (risk: ${data.assessment.riskScore})`);

    // Handle auto-executed transactions (Safe signed by agent wallet)
    if (data.autoExecuted && data.txHash) {
      quoteResultEl.innerHTML = `
        <div style="color:var(--green);font-weight:bold;margin-bottom:6px">Executed automatically by agent</div>
        <div style="font-size:11px">No Ledger approval needed (below spending limit)</div>
        <div style="margin-top:8px">
          <a href="${data.explorerUrl}" target="_blank" style="color:var(--accent)">View on Etherscan: ${data.txHash.slice(0, 10)}...</a>
        </div>
      `;
      quoteResultEl.style.display = "block";
      intentStatusEl.textContent = "Auto-executed via Safe";
      intentStatusEl.style.color = "var(--green)";
      log(`Auto-executed via Safe: ${data.txHash}`);
    } else if (data.quoteData) {
      // NEEDS_APPROVAL — show the Sign & Swap flow
      lastQuoteData = data.quoteData;

      const routingBadge = data.quoteData.isMevProtected
        ? `<span class="badge badge-mev">MEV Protected</span>`
        : `<span class="badge badge-classic">AMM</span>`;

      quoteResultEl.innerHTML = `
        Routing: ${routingBadge}<br>
        Risk: ${verdictBadge}<br>
        ${data.quoteData.approvalNeeded ? "Permit2 approval needed<br>" : "Permit2 approved<br>"}
        <button id="sign-swap-btn" class="btn btn-sign" style="margin-top:8px;width:100%">Sign & Swap on Ledger</button>
        <div id="swap-status" style="margin-top:6px;font-size:11px;"></div>
      `;
      quoteResultEl.style.display = "block";

      document.getElementById("sign-swap-btn")!.addEventListener("click", () =>
        handleSignAndSwap(data.quoteData, message)
      );

      intentStatusEl.textContent = "Quote ready — sign on Ledger to execute.";
      intentStatusEl.style.color = "var(--green)";
      log("Quote fetched — ready to sign on Ledger");
    } else if (data.assessment.verdict === "AUTO_EXECUTE") {
      intentStatusEl.textContent = "Auto-executed (low risk)";
      intentStatusEl.style.color = "var(--green)";
      log("Auto-executed — no Ledger approval needed");
    } else {
      intentStatusEl.textContent = "Plan created — no swap quote needed.";
    }
  } catch (err: any) {
    log(`❌ Intent error: ${err.message}`);
    intentStatusEl.textContent = `Error: ${err.message}`;
    intentStatusEl.style.color = "var(--red)";
  } finally {
    intentBtn.disabled = false;
  }
});

// Allow Enter key to submit intent
intentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") intentBtn.click();
});

// ─── Quote flow ───
let lastQuoteData: any = null;

quoteBtn.addEventListener("click", async () => {
  const amountEth = swapAmountInput.value.trim();
  if (!amountEth || isNaN(Number(amountEth))) {
    log("Invalid amount");
    return;
  }

  // Get wallet address from connected device
  if (!fullWalletAddress) {
    log("⚠ Connect Ledger first to get wallet address");
    return;
  }
  const address = fullWalletAddress;

  // Convert ETH to wei using ethers for precision
  const { ethers } = await import("ethers");
  const amountWei = ethers.parseEther(amountEth).toString();

  log(`Requesting quote: ${amountEth} WETH → USDC…`);
  quoteBtn.disabled = true;
  quoteResultEl.style.display = "none";

  try {
    const res = await fetch(`${BRIDGE_HTTP}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: address,
        amount: amountWei,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    lastQuoteData = data;

    const routingBadge = data.isMevProtected
      ? `<span class="badge badge-mev">MEV Protected</span>`
      : `<span class="badge badge-classic">AMM</span>`;

    const riskBadge = `<span class="badge badge-risk-${data.riskLevel}">${data.riskLevel.replace("_", " ")}</span>`;

    quoteResultEl.innerHTML = `
      Routing: ${routingBadge}<br>
      ${data.isGasless ? "Gasless (UniswapX)<br>" : ""}
      Risk: ${riskBadge}<br>
      ${data.approvalNeeded ? "⚠ Permit2 approval needed<br>" : "✓ Permit2 approved<br>"}
      Trade ID: ${data.tradeId.slice(0, 12)}…<br>
      <button id="sign-swap-btn" class="btn btn-sign" style="margin-top:8px;width:100%">Sign & Swap on Ledger</button>
      <div id="swap-status" style="margin-top:6px;font-size:11px;"></div>
    `;
    quoteResultEl.style.display = "block";

    log(`Quote received — ${data.routing}${data.isMevProtected ? " (MEV Protected)" : ""}, risk: ${data.riskLevel}`);

    // Wire up the Sign & Swap button
    document.getElementById("sign-swap-btn")!.addEventListener("click", () => handleSignAndSwap(data, amountEth));
  } catch (err: any) {
    log(`❌ Quote error: ${err.message}`);
    quoteResultEl.innerHTML = `Error: ${err.message}`;
    quoteResultEl.style.display = "block";
  } finally {
    quoteBtn.disabled = false;
  }
});

// ─── Sign & Swap flow ───
async function handleSignAndSwap(quoteData: any, amountEth: string): Promise<void> {
  const swapStatusEl = document.getElementById("swap-status")!;
  const signSwapBtn = document.getElementById("sign-swap-btn") as HTMLButtonElement;

  if (deviceStatus !== "ready") {
    log("⚠ Device not ready — connect Ledger first");
    return;
  }

  const sessionId = getActiveSession();
  if (!sessionId) {
    log("⚠ No active Ledger session");
    return;
  }

  signSwapBtn.disabled = true;
  swapStatusEl.textContent = "";
  swapStatusEl.style.color = "";
  const { ethers } = await import("ethers");

  const totalSteps = (quoteData.approvalNeeded ? 1 : 0) + (quoteData.permitData ? 1 : 0) + 2; // +2 = sign swap tx + broadcast
  let step = 0;
  const status = (msg: string) => {
    step++;
    swapStatusEl.textContent = `[${step}/${totalSteps}] ${msg}`;
    log(msg);
  };

  try {
    const signer = createSigner(sessionId);

    // Fetch current nonce + gas from the server (which has the RPC provider)
    const nonceRes = await fetch(`${BRIDGE_HTTP}/nonce/${fullWalletAddress}`);
    const { nonce, maxFeePerGas, maxPriorityFeePerGas } = await nonceRes.json();
    let currentNonce = nonce;
    log(`Wallet nonce: ${nonce}, gas: ${(BigInt(maxFeePerGas) / 1000000000n).toString()} gwei`);

    // ── Step: Permit2 token approval (if needed) ──
    if (quoteData.approvalNeeded && quoteData.approvalTx) {
      status("Sign Permit2 approval on Ledger…");
      setDeviceStatus("signing");

      const approvalTx = ethers.Transaction.from({
        to: quoteData.approvalTx.to,
        data: quoteData.approvalTx.data,
        value: quoteData.approvalTx.value || "0x0",
        chainId: 11155111,
        gasLimit: quoteData.approvalTx.gasLimit || 100000,
        type: 2,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce: currentNonce,
      });

      const approvalSig = await requestSignature(signer, approvalTx.unsignedSerialized, (s) => log(`  ↳ ${s}`));
      log(`✓ Approval signed — r=${approvalSig.r.slice(0, 14)}…`);

      // Assemble signed tx and broadcast
      const signedApproval = approvalTx.clone();
      signedApproval.signature = ethers.Signature.from(approvalSig);

      status("Broadcasting Permit2 approval…");
      const broadcastRes = await fetch(`${BRIDGE_HTTP}/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedTx: signedApproval.serialized }),
      });
      const broadcastResult = await broadcastRes.json();
      if (!broadcastRes.ok) throw new Error(broadcastResult.error);
      log(`✓ Approval broadcast: ${broadcastResult.txHash}`);

      currentNonce++;

      // Wait a bit for the approval to propagate
      log("Waiting for approval to confirm…");
      await new Promise((r) => setTimeout(r, 5000));
    }

    // ── Step: Sign Permit2 typed data (EIP-712) if present ──
    let permit2Signature: string | undefined;

    if (quoteData.permitData) {
      status("Sign Permit2 message on Ledger…");
      setDeviceStatus("signing");

      const typedData: TypedData = {
        domain: quoteData.permitData.domain,
        types: quoteData.permitData.types,
        primaryType: quoteData.permitData.primaryType || Object.keys(quoteData.permitData.types).find((k: string) => k !== "EIP712Domain") || "PermitSingle",
        message: quoteData.permitData.values,
      };

      const sig = await signTypedData(signer, typedData, (s) => log(`  ↳ ${s}`));

      permit2Signature = ethers.Signature.from({
        v: sig.v,
        r: sig.r,
        s: sig.s,
      }).serialized;

      log(`✓ Permit2 message signed`);
    }

    // ── Step: Get unsigned swap tx from Uniswap API ──
    log("Fetching swap calldata from Uniswap…");
    const swapRes = await fetch(`${BRIDGE_HTTP}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quote: quoteData.quote,
        permitData: quoteData.permitData,
        signature: permit2Signature,
        routing: quoteData.routing,
      }),
    });

    if (!swapRes.ok) {
      const err = await swapRes.json();
      throw new Error(err.error || `HTTP ${swapRes.status}`);
    }

    const swapResult = await swapRes.json();

    // UniswapX: already submitted, no on-chain tx needed
    if (swapResult.type === "uniswapx") {
      log(`✓ UniswapX order submitted — orderId: ${swapResult.orderId}`);
      swapStatusEl.innerHTML = `✓ Order: ${swapResult.orderId.slice(0, 16)}…`;
      swapStatusEl.style.color = "var(--green)";
      setDeviceStatus("ready");
      return;
    }

    // Classic: we have an unsigned tx — sign it on Ledger
    const unsignedTx = swapResult.unsignedTx;

    // ── Detailed tx logging ──
    log(`── Unsigned Swap Tx from Uniswap ──`);
    log(`  to:       ${unsignedTx.to}`);
    log(`  value:    ${unsignedTx.value}`);
    log(`  gasLimit: ${unsignedTx.gasLimit || unsignedTx.gas || "not set"}`);
    log(`  data:     ${(unsignedTx.data || "").slice(0, 40)}…`);
    log(`  nonce:    ${currentNonce}`);
    log(`  maxFee:   ${maxFeePerGas} (${(BigInt(maxFeePerGas) / 1000000000n).toString()} gwei)`);
    log(`  maxPrio:  ${maxPriorityFeePerGas}`);

    // Use Uniswap API's gas estimate with a 20% buffer for safety
    const rawGasLimit = Number(unsignedTx.gasLimit || unsignedTx.gas || 350000);
    const gasLimit = Math.ceil(rawGasLimit * 1.2);
    log(`  gasLimit: ${rawGasLimit} (buffered to ${gasLimit})`);

    status("Sign swap transaction on Ledger…");
    setDeviceStatus("signing");

    const swapTx = ethers.Transaction.from({
      to: unsignedTx.to,
      data: unsignedTx.data || "0x",
      value: unsignedTx.value || "0x0",
      chainId: 11155111,
      gasLimit,
      type: 2,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce: currentNonce,
    });

    log(`Assembled tx hash (unsigned): ${swapTx.unsignedHash}`);

    const swapSig = await requestSignature(signer, swapTx.unsignedSerialized, (s) => log(`  ↳ ${s}`));
    log(`✓ Swap tx signed`);

    // Assemble the fully signed transaction
    const signedSwap = swapTx.clone();
    signedSwap.signature = ethers.Signature.from(swapSig);
    log(`Signed tx length: ${signedSwap.serialized.length} chars`);

    // ── Step: Broadcast to Sepolia ──
    status("Broadcasting swap to Sepolia…");
    setDeviceStatus("ready");

    const broadcastRes = await fetch(`${BRIDGE_HTTP}/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedTx: signedSwap.serialized }),
    });

    const broadcastResult = await broadcastRes.json();
    if (!broadcastRes.ok) throw new Error(broadcastResult.error);

    log(`✓ Swap broadcast! ${broadcastResult.txHash}`);
    log(`  Explorer: ${broadcastResult.explorerUrl}`);
    swapStatusEl.innerHTML = `✓ <a href="${broadcastResult.explorerUrl}" target="_blank" style="color:var(--green)">${broadcastResult.txHash.slice(0, 18)}…</a>`;
    swapStatusEl.style.color = "var(--green)";
  } catch (err: any) {
    log(`❌ Swap error: ${err.message}`);
    swapStatusEl.textContent = `✗ ${err.message}`;
    swapStatusEl.style.color = "var(--red)";
    setDeviceStatus("ready");
  } finally {
    signSwapBtn.disabled = false;
  }
}

// ─── Compute provider toggle ───
function setProviderUI(provider: string): void {
  if (provider === "0g") {
    providerGroqBtn.className = "btn btn-secondary";
    providerGroqBtn.style.flex = "1";
    providerGroqBtn.style.fontSize = "11px";
    providerGroqBtn.style.padding = "7px 4px";
    provider0gBtn.className = "btn btn-primary";
    provider0gBtn.style.flex = "1";
    provider0gBtn.style.fontSize = "11px";
    provider0gBtn.style.padding = "7px 4px";
    provider0gBtn.style.background = "var(--green)";
    providerStatusEl.textContent = "Active: 0G Compute — TeeML verified";
    providerStatusEl.style.color = "var(--green)";
  } else {
    providerGroqBtn.className = "btn btn-primary";
    providerGroqBtn.style.flex = "1";
    providerGroqBtn.style.fontSize = "11px";
    providerGroqBtn.style.padding = "7px 4px";
    provider0gBtn.className = "btn btn-secondary";
    provider0gBtn.style.flex = "1";
    provider0gBtn.style.fontSize = "11px";
    provider0gBtn.style.padding = "7px 4px";
    provider0gBtn.style.background = "";
    providerStatusEl.textContent = "Active: Groq";
    providerStatusEl.style.color = "var(--text-dim)";
  }
}

async function switchProvider(provider: string): Promise<void> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/set-compute-provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (data.success) {
      setProviderUI(provider);
      log(`Compute provider switched to: ${provider}`);
    }
  } catch (err: any) {
    log(`Failed to switch provider: ${err.message}`);
  }
}

providerGroqBtn.addEventListener("click", () => switchProvider("groq"));
provider0gBtn.addEventListener("click", () => switchProvider("0g"));

// Fetch initial provider on load
fetch(`${BRIDGE_HTTP}/compute-provider`)
  .then(r => r.json())
  .then((data: any) => setProviderUI(data.provider))
  .catch(() => {});

// ─── Init ───
log("SafeSwarm × Ledger — Test Console initialized");
connectBridge();
