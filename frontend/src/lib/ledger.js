// ─── Ledger DMK + Signer — lazy browser-only wrappers ───
// Mirrors the working API from src/integrations/ledger/dmk.ts and signer.ts exactly.
// All imports are dynamic to prevent SSR crashes.

let dmk = null;
let activeSessionId = null;
let discoverySubscription = null;
let discoveredDevices = new Map();

// ── DMK lifecycle ──

export async function initDMK() {
  if (dmk) return dmk;

  const { DeviceManagementKitBuilder, ConsoleLogger } = await import('@ledgerhq/device-management-kit');
  const { webBleTransportFactory } = await import('@ledgerhq/device-transport-kit-web-ble');

  dmk = new DeviceManagementKitBuilder()
    .addLogger(new ConsoleLogger())
    .addTransport(webBleTransportFactory)
    .build();

  return dmk;
}

export function getDMK() {
  if (!dmk) throw new Error('DMK not initialized — call initDMK() first');
  return dmk;
}

export function discoverDevices(onDevice, onError) {
  stopDiscovering();

  discoverySubscription = getDMK().startDiscovering({}).subscribe({
    next: (device) => {
      discoveredDevices.set(device.id, device);
      onDevice(device);
    },
    error: (err) => onError?.(err),
  });

  return discoverySubscription;
}

export function stopDiscovering() {
  if (discoverySubscription) {
    discoverySubscription.unsubscribe();
    discoverySubscription = null;
  }
}

export async function connectDevice(deviceId) {
  const device = discoveredDevices.get(deviceId);
  if (!device) throw new Error(`No discovered device for id: ${deviceId}`);

  const sessionId = await getDMK().connect({ device });
  activeSessionId = sessionId;
  return sessionId;
}

export async function disconnectDevice() {
  stopDiscovering();
  if (!activeSessionId) return;
  try {
    await getDMK().disconnect({ sessionId: activeSessionId });
  } catch { /* ignore */ }
  activeSessionId = null;
}

export function getActiveSession() {
  return activeSessionId;
}

// ── Open Ledger app ──

export async function openApp(appName = 'Uniswap', sessionId, onStatus) {
  const { OpenAppDeviceAction } = await import('@ledgerhq/device-management-kit');
  const id = sessionId ?? activeSessionId;
  if (!id) throw new Error('No active session');

  const deviceAction = new OpenAppDeviceAction({ input: { appName } });

  return new Promise((resolve, reject) => {
    const { observable } = getDMK().executeDeviceAction({ sessionId: id, deviceAction });
    observable.subscribe({
      next: (state) => {
        if (state.status === 'pending') onStatus?.(`Opening ${appName} app...`);
        else if (state.status === 'completed') resolve();
        else if (state.status === 'error') reject(new Error(state.error?.message || `Failed to open ${appName}`));
      },
      error: reject,
    });
  });
}

// ── Signer ──

export async function createSigner(sessionId) {
  const { SignerEthBuilder } = await import('@ledgerhq/device-signer-kit-ethereum');
  const id = sessionId ?? activeSessionId;
  if (!id) throw new Error('No active session');
  return new SignerEthBuilder({ dmk: getDMK(), sessionId: id }).build();
}

export async function getAddress(signer, derivationPath = "44'/60'/0'/0/0") {
  return new Promise((resolve, reject) => {
    const { observable } = signer.getAddress(derivationPath, { checkOnDevice: false });
    observable.subscribe({
      next: (state) => {
        if (state.status === 'completed') resolve(state.output.address);
        else if (state.status === 'error') reject(new Error(state.error?.message || 'Failed to get address'));
      },
      error: reject,
    });
  });
}

export async function requestSignature(signer, unsignedTxHex, onStatus, derivationPath = "44'/60'/0'/0/0") {
  const { ethers } = await import('ethers');
  const txBytes = ethers.getBytes(unsignedTxHex);

  return new Promise((resolve, reject) => {
    const { observable } = signer.signTransaction(derivationPath, txBytes, { skipOpenApp: true });
    observable.subscribe({
      next: (state) => {
        if (state.status === 'pending') onStatus?.('Waiting for approval on device...');
        else if (state.status === 'completed') resolve(state.output);
        else if (state.status === 'error') reject(new Error(state.error?.message || 'User rejected transaction'));
      },
      error: reject,
    });
  });
}

export async function signTypedData(signer, typedData, onStatus, derivationPath = "44'/60'/0'/0/0") {
  return new Promise((resolve, reject) => {
    const { observable } = signer.signTypedData(derivationPath, typedData, { skipOpenApp: true });
    observable.subscribe({
      next: (state) => {
        if (state.status === 'pending') onStatus?.('Review typed data on device...');
        else if (state.status === 'completed') resolve(state.output);
        else if (state.status === 'error') reject(new Error(state.error?.message || 'User rejected typed data signing'));
      },
      error: reject,
    });
  });
}
