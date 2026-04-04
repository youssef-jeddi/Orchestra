// ─── SafeSwarm × Ledger — Ethereum Signer Service ───
// Browser-side. Wraps the Ledger Ethereum Signer Kit for transaction signing.

import { SignerEthBuilder, type SignerEth } from "@ledgerhq/device-signer-kit-ethereum";
import type { TypedData } from "@ledgerhq/device-signer-kit-ethereum/api";
import { getDMK } from "./dmk";
import { ethers } from "ethers";

export type { SignerEth, TypedData };

export interface SignatureResult {
  v: number;
  r: string;
  s: string;
}

/** Create a SignerEth instance scoped to the given DMK session. */
export function createSigner(sessionId: string): SignerEth {
  const dmk = getDMK();
  return new SignerEthBuilder({ dmk, sessionId }).build();
}

/**
 * Request a transaction signature on the physical Ledger device.
 *
 * This pauses execution until the user physically approves or rejects
 * on the device — the "hardware gate".
 *
 * @param signer         - SignerEth from createSigner()
 * @param unsignedTxHex  - RLP-encoded unsigned transaction (hex string)
 * @param onStatus       - Optional callback for intermediate status updates
 * @param derivationPath - BIP44 path (defaults to first ETH account)
 * @returns Promise resolving to { v, r, s } on approval, rejects on rejection
 */
export function requestSignature(
  signer: SignerEth,
  unsignedTxHex: string,
  onStatus?: (status: string) => void,
  derivationPath: string = "44'/60'/0'/0/0"
): Promise<SignatureResult> {
  // Parse hex to Uint8Array for the signer
  const txBytes = ethers.getBytes(unsignedTxHex);

  return new Promise<SignatureResult>((resolve, reject) => {
    // signTransaction(derivationPath, transaction, options?)
    const { observable } = signer.signTransaction(derivationPath, txBytes);

    observable.subscribe({
      next: (state: any) => {
        if (state.status === "pending") {
          onStatus?.("Waiting for approval on device…");
        } else if (state.status === "completed") {
          const { v, r, s } = state.output;
          resolve({ v, r, s });
        } else if (state.status === "error") {
          reject(
            new Error(state.error?.message || "User rejected transaction")
          );
        }
      },
      error: (err: Error) => reject(err),
    });
  });
}

/**
 * Request an EIP-712 typed data signature on the Ledger device.
 * Used for Permit2 signing (Uniswap gasless approvals).
 */
export function signTypedData(
  signer: SignerEth,
  typedData: TypedData,
  onStatus?: (status: string) => void,
  derivationPath: string = "44'/60'/0'/0/0"
): Promise<SignatureResult> {
  return new Promise<SignatureResult>((resolve, reject) => {
    const { observable } = signer.signTypedData(derivationPath, typedData);

    observable.subscribe({
      next: (state: any) => {
        if (state.status === "pending") {
          onStatus?.("Review typed data on device…");
        } else if (state.status === "completed") {
          const { v, r, s } = state.output;
          resolve({ v, r, s });
        } else if (state.status === "error") {
          reject(
            new Error(state.error?.message || "User rejected typed data signing")
          );
        }
      },
      error: (err: Error) => reject(err),
    });
  });
}

/**
 * Get the Ethereum address from the connected Ledger device.
 * Useful to confirm which account is active.
 */
export function getAddress(
  signer: SignerEth,
  derivationPath: string = "44'/60'/0'/0/0"
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // getAddress(derivationPath, options?)
    const { observable } = signer.getAddress(derivationPath, {
      checkOnDevice: false,
    });

    observable.subscribe({
      next: (state: any) => {
        if (state.status === "completed") {
          resolve(state.output.address);
        } else if (state.status === "error") {
          reject(
            new Error(state.error?.message || "Failed to get address")
          );
        }
      },
      error: (err: Error) => reject(err),
    });
  });
}
