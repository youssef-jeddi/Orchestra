import 'dotenv/config';
import { write, readMany } from '../integrations/zero-g/storage';
import { runWatcher } from '../agents/watcher/index';

async function main() {
  // 1. Seed previous prices from CoinGecko
  console.log('\n=== SEED: Fetching real token prices from CoinGecko ===');
  const priceRes = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd'
  );
  if (!priceRes.ok) {
    throw new Error(`CoinGecko fetch failed: ${priceRes.status}`);
  }
  const priceData = await priceRes.json() as { ethereum: { usd: number }; bitcoin: { usd: number } };
  const previousPrices = {
    ethereum: priceData.ethereum.usd,
    bitcoin: priceData.bitcoin.usd,
    fetchedAt: new Date().toISOString(),
  };
  console.log('Previous prices:', previousPrices);
  await write('prices:previous', previousPrices);

  // 2. Seed portfolio
  console.log('\n=== SEED: Writing portfolio to storage ===');
  const portfolio = { eth: 2.5, usdc: 1000, wbtc: 0.1 };
  console.log('Portfolio:', portfolio);
  await write('portfolio:current', portfolio);

  // 3. Run the Watcher
  console.log('\n=== RUNNING WATCHER ===');
  const result = await runWatcher();
  console.log('\nWatcher result:', JSON.stringify(result, null, 2));

  // 4. Read all flags
  console.log('\n=== READING FLAGS ===');
  const flags = await readMany('flags');
  console.log(`\nTotal flags written: ${flags.length}`);
  for (const flag of flags) {
    const f = flag as Record<string, unknown>;
    console.log(`  - [${f.type}] ${f.message ?? f.summary ?? f.reason ?? JSON.stringify(f)}`);
  }

  console.log('\n✅ Watcher test complete');
}

main().catch(console.error);
