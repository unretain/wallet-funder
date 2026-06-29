import "dotenv/config";
import { runAll, FunderEvent } from "./lib";

const arg = process.argv[2];
if (!arg || isNaN(parseFloat(arg))) {
  console.error("Usage: npx ts-node index.ts <SOL_AMOUNT>");
  console.error("  e.g: npx ts-node index.ts 11");
  process.exit(1);
}

runAll(parseFloat(arg), (e: FunderEvent) => {
  if (e.type === "chain_step")     console.log(`[${e.step}/6] ${e.label} — ${e.from.slice(0,8)}… → ${e.to.slice(0,8)}…`);
  if (e.type === "chain_step_ok")  console.log(`      ✓ ${e.sig.slice(0, 20)}…`);
  if (e.type === "chain_done")     console.log("\n✓ Chain done\n");
  if (e.type === "dist_start")     console.log(`Distributing to ${e.total} wallets (~${(e.perWallet/1e9).toFixed(4)} SOL each)`);
  if (e.type === "dist_wallet")    console.log(`  [${e.index+1}] ${e.pubkey.slice(0,10)}… ← ${(e.amount/1e9).toFixed(4)} SOL`);
  if (e.type === "dist_done")      console.log("\n✓ All wallets funded");
  if (e.type === "error")          console.error(`\n✗ ${e.message}`);
}).catch(err => { console.error(err); process.exit(1); });
