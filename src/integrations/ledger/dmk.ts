// ─── SafeSwarm × Ledger — Device Management Kit Wrapper ───
// Browser-side only. Handles device discovery, connection, and session management.

import {
  DeviceManagementKitBuilder,
  ConsoleLogger,
  OpenAppDeviceAction,
  type DeviceManagementKit,
  type DiscoveredDevice,
} from "@ledgerhq/device-management-kit";
import { webBleTransportFactory } from "@ledgerhq/device-transport-kit-web-ble";
import type { Subscription } from "rxjs";

let dmkInstance: DeviceManagementKit | null = null;
let activeSessionId: string | null = null;
let discoverySubscription: Subscription | null = null;
let discoveredDevices = new Map<string, DiscoveredDevice>();

/** Initialize the DMK singleton. Call once at app startup. */
export function initDMK(): DeviceManagementKit {
  if (dmkInstance) return dmkInstance;

  dmkInstance = new DeviceManagementKitBuilder()
    .addLogger(new ConsoleLogger())
    .addTransport(webBleTransportFactory)
    .build();

  return dmkInstance;
}

/** Get the initialized DMK instance (throws if not initialized). */
export function getDMK(): DeviceManagementKit {
  if (!dmkInstance) {
    throw new Error("DMK not initialized — call initDMK() first.");
  }
  return dmkInstance;
}

/**
 * Start USB discovery. Returns an Observable that emits each DiscoveredDevice
 * as it is found. The caller must subscribe to begin scanning.
 *
 * IMPORTANT: startDiscovering() itself returns the Observable.
 * Each emission is a single DiscoveredDevice (not an array).
 */
export function discoverDevices(
  onDevice: (device: DiscoveredDevice) => void,
  onError?: (err: Error) => void
): void {
  const dmk = getDMK();

  // Clean up any previous discovery
  stopDiscovering();

  discoverySubscription = dmk.startDiscovering({}).subscribe({
    next: (device: DiscoveredDevice) => {
      discoveredDevices.set(device.id, device);
      onDevice(device);
    },
    error: (err: Error) => {
      onError?.(err);
    },
  });
}

/** Stop scanning for devices. */
export function stopDiscovering(): void {
  if (discoverySubscription) {
    discoverySubscription.unsubscribe();
    discoverySubscription = null;
  }
}

/**
 * Connect to a discovered device by its ID.
 * Returns the sessionId needed by the signer.
 */
export async function connectDevice(deviceId: string): Promise<string> {
  const dmk = getDMK();
  const device = discoveredDevices.get(deviceId);
  if (!device) {
    throw new Error(`No discovered device found for id: ${deviceId}. Was discovery run first?`);
  }
  const sessionId = await dmk.connect({ device });
  activeSessionId = sessionId;
  return sessionId;
}

/** Get the currently active session ID (null if disconnected). */
export function getActiveSession(): string | null {
  return activeSessionId;
}

/** Get the device session state (locked, unlocked, etc.). */
export function getDeviceState(sessionId?: string) {
  const id = sessionId ?? activeSessionId;
  if (!id) return null;
  return getDMK().getDeviceSessionState({ sessionId: id });
}

/**
 * Open a specific app on the Ledger device (e.g. "Uniswap", "Ethereum").
 * The Uniswap app enables clear signing for Uniswap transactions.
 */
export function openApp(
  appName: string = "Uniswap",
  sessionId?: string,
  onStatus?: (status: string) => void
): Promise<void> {
  const dmk = getDMK();
  const id = sessionId ?? activeSessionId;
  if (!id) throw new Error("No active session — connect first");

  const deviceAction = new OpenAppDeviceAction({ input: { appName } });

  return new Promise<void>((resolve, reject) => {
    const { observable } = dmk.executeDeviceAction({ sessionId: id, deviceAction });

    observable.subscribe({
      next: (state: any) => {
        if (state.status === "pending") {
          onStatus?.(`Opening ${appName} app…`);
        } else if (state.status === "completed") {
          resolve();
        } else if (state.status === "error") {
          reject(new Error(state.error?.message || `Failed to open ${appName}`));
        }
      },
      error: (err: Error) => reject(err),
    });
  });
}

/** Disconnect the current session. */
export async function disconnectDevice(): Promise<void> {
  stopDiscovering();
  if (!activeSessionId) return;
  const dmk = getDMK();
  await dmk.disconnect({ sessionId: activeSessionId });
  activeSessionId = null;
}
