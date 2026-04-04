import { ethers } from 'ethers';

const wallet = ethers.Wallet.createRandom();

console.log('\n=== Agent Hot Wallet Generated ===\n');
console.log(`AGENT_PRIVATE_KEY=${wallet.privateKey}`);
console.log(`AGENT_WALLET_ADDRESS=${wallet.address}`);
console.log('\nAdd these to your .env file.');
console.log('Fund this address with Sepolia ETH from https://www.alchemy.com/faucets/ethereum-sepolia\n');
