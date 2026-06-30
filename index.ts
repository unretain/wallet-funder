/**
 * CLI entry — headless distribute. The web UI (server.ts) is the main interface.
 *   npx ts-node index.ts distribute
 */
import "dotenv/config";
import { distributeWithCallback, DistEvent } from "./lib";

async function main() {
  const cmd = process.argv[2];

  if (cmd === "distribute") {
    await distributeWithCallback((e: DistEvent) => {
      if (e.type === "dist_start")  console.log(`Distributing to ${e.total} wallets (~${(e.perWallet/1e9).toFixed(4)} SOL each)`);
      if (e.type === "dist_wallet") console.log(`  [${e.index+1}] ${e.pubkey.slice(0,10)}… ← ${(e.amount/1e9).toFixed(4)} SOL`);
      if (e.type === "dist_done")   console.log("✓ Distribution complete");
      if (e.type === "error")       console.error(`✗ ${e.message}`);
    });
    return;
  }

  console.log("Usage: npx ts-node index.ts distribute");
  console.log("(For the full flow use the web UI: npm run web)");
}

main().catch(err => { console.error(err); process.exit(1); });
