// ─── Scripts — rotate one account's agent key on SpendingLimitModuleV2 (ORC-38, humans only) ───
// Sends real Sepolia transactions paid by the relayer key (AGENT_PRIVATE_KEY). Run it on the bridge
// host with the bridge's env and storage (stop the bridge first with the file storage backend, so the
// two don't write the storage file at the same time):
//   npx tsx src/scripts/rotate-agent-key.ts propose <wallet>   create a successor key; the current key signs the proposal
//   npx tsx src/scripts/rotate-agent-key.ts accept <wallet>    after the module's delay: accept, then use the new key
// Until `accept`, the current key keeps working. The guardian, the admin or the owner can cancel the
// proposal in between (cancelAgentProposal). For a leaked key don't rotate: revoke (revokeAgent) at
// once, then have the admin propose a fresh key.

import "dotenv/config";
import { ethers } from "ethers";
import { read } from "../integrations/zero-g/storage";
import { makeSepoliaProvider } from "../utils/rpc";
import { spendingModuleAddress, moduleVersion, SPENDING_MODULE_V2_ABI } from "../integrations/safe/spendingModule";
import { getAgentSigner, beginAgentRotation, adoptAgentIfAccepted } from "../integrations/safe/agentKeys";
import { signPropose } from "../integrations/safe/agentAuth";

async function main() {
  const [cmd, walletArg] = process.argv.slice(2);
  if (!["propose", "accept"].includes(cmd ?? "") || !walletArg || !ethers.isAddress(walletArg)) {
    console.error("usage: rotate-agent-key.ts propose|accept <wallet address>");
    process.exit(2);
  }
  const wallet = ethers.getAddress(walletArg);
  const moduleAddress = spendingModuleAddress();
  if (!moduleAddress) throw new Error("SPENDING_MODULE_ADDRESS is not set");
  const provider = makeSepoliaProvider();
  if ((await moduleVersion(moduleAddress, provider)) < 2) throw new Error("the configured module isn't SpendingLimitModuleV2");
  const record = (await read(`safe:${wallet.toLowerCase()}`)) as { safeAddress?: string } | null;
  if (!record?.safeAddress) throw new Error("no finished account is recorded for this wallet");
  const safe = ethers.getAddress(record.safeAddress);
  const relayer = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY!, provider);
  const module = new ethers.Contract(moduleAddress, SPENDING_MODULE_V2_ABI, relayer);

  if (cmd === "propose") {
    const current = await getAgentSigner(wallet);
    if (!current) throw new Error("this account has no agent key");
    if ((await module.agentOf(safe)).toLowerCase() !== current.address.toLowerCase()) throw new Error("the module doesn't name this account's current key");
    const next = await beginAgentRotation(wallet);
    const nonce = BigInt(await module.nonces(safe));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
    const { chainId } = await provider.getNetwork();
    const sig = await signPropose(current, moduleAddress, chainId, safe, next, nonce, deadline);
    const tx = await module.proposeAgentSigned(safe, next, deadline, sig);
    await tx.wait();
    const [, readyAt] = await module.pendingAgentOf(safe);
    console.log(`proposed the successor key ${next} (tx ${tx.hash}); accept after ${new Date(Number(readyAt) * 1000).toISOString()}`);
    return;
  }

  const tx = await module.acceptAgent(safe);
  await tx.wait();
  const adopted = await adoptAgentIfAccepted(wallet, await module.agentOf(safe));
  console.log(adopted ? `accepted (tx ${tx.hash}); the bridge now signs with the new key` : `accepted (tx ${tx.hash}), but the stored keys don't match the module: check the account`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
