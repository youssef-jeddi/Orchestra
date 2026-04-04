import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
    fs: {
      // Allow importing from parent dir (dmk.ts, signer.ts, types.ts)
      allow: [".."],
    },
  },
  // Resolve Ledger packages correctly
  optimizeDeps: {
    include: [
      "@ledgerhq/device-management-kit",
      "@ledgerhq/device-transport-kit-web-ble",
      "@ledgerhq/device-signer-kit-ethereum",
      "ethers",
      "rxjs",
    ],
  },
});
