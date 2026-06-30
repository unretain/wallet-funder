import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── CONFIG ─────────────────────────────────────────────────────────────────
export function getConfig() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL not set in .env");
  const bundleRaw = process.env.BUNDLE_KEY;
  if (!bundleRaw) throw new Error("BUNDLE_KEY not set in .env");
  const bundle      = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(bundleRaw)));
  const walletsPath = resolve(__dirname, process.env.WALLETS_PATH ?? "./wallets.json");
  const walletCount = parseInt(process.env.WALLET_COUNT ?? "100");
  const conn        = new Connection(rpc, "confirmed");
  return { conn, bundle, walletsPath, walletCount };
}

// ── TYPES ──────────────────────────────────────────────────────────────────
export type ChainEvent =
  | { type: "waiting";    addr1: string; balance: number; needed: number }
  | { type: "chain_step"; step: number; label: string; from: string; to: string }
  | { type: "chain_ok";   step: number; sig: string }
  | { type: "chain_done"; bundleBalance: number }
  | { type: "error";      message: string };

export type DistEvent =
  | { type: "dist_start";  total: number; perWallet: number }
  | { type: "dist_wallet"; index: number; pubkey: string; amount: number; sig: string }
  | { type: "dist_done" }
  | { type: "error";       message: string };

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const HOP_FEE      = 6_000_000;
const WSOL_RENT    = 2_039_280;
const DIST_FEE_BUF = 10_000_000;

// ── TX HELPER ──────────────────────────────────────────────────────────────
async function sendTx(conn: Connection, tx: Transaction, ...signers: Keypair[]): Promise<string> {
  tx.feePayer = signers[0].publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

function solTx(from: PublicKey, to: PublicKey, lamports: number): Transaction {
  return new Transaction().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
}

// ── SOL PRICE (cached, multi-source) ────────────────────────────────────────
// Fetches at most once per 60s no matter how many clients poll. Tries Jupiter
// first (reliable from server IPs), then CoinGecko, then env fallback, then the
// last good value. Never spams an API and never returns 0 once seeded.
const SOL_MINT = "So11111111111111111111111111111111111111112";
let _priceCache = { value: 0, ts: 0 };
const PRICE_TTL_MS = 60_000;

async function fetchJupiter(): Promise<number> {
  const r = await fetch(`https://lite-api.jup.ag/price/v2?ids=${SOL_MINT}`, { signal: AbortSignal.timeout(4000) });
  const d: any = await r.json();
  return Number(d?.data?.[SOL_MINT]?.price) || 0;
}
async function fetchCoinGecko(): Promise<number> {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(4000) });
  const d: any = await r.json();
  return Number(d?.solana?.usd) || 0;
}

export async function getSolPrice(): Promise<number> {
  const now = Date.now();
  // Serve cached value if fresh
  if (_priceCache.value > 0 && now - _priceCache.ts < PRICE_TTL_MS) return _priceCache.value;

  for (const src of [fetchJupiter, fetchCoinGecko]) {
    try {
      const p = await src();
      if (p > 0) { _priceCache = { value: p, ts: now }; return p; }
    } catch { /* try next */ }
  }

  // Both APIs failed — use manual env override, else last known good value.
  const fallback = Number(process.env.SOL_PRICE_USD) || _priceCache.value || 0;
  if (fallback > 0) _priceCache = { value: fallback, ts: now };
  return fallback;
}

// ── COST ───────────────────────────────────────────────────────────────────
export function calcCost(perWalletSol: number, walletCount: number, solPrice: number) {
  const TX_FEE        = 0.000005;
  const ATA_RENT      = 0.00204;
  const JITO_TIP      = 0.05;
  const POOL_COST     = 0.05;
  const CHAIN_FEES    = (HOP_FEE / LAMPORTS_PER_SOL) * 8;
  const BUFFER        = 0.5;

  const buyTotal    = perWalletSol * walletCount;
  const distFees    = walletCount * TX_FEE;
  const depositFees = walletCount * TX_FEE;
  const tokenATAs   = walletCount * ATA_RENT;
  const totalSol    = buyTotal + distFees + depositFees + tokenATAs + JITO_TIP + POOL_COST + CHAIN_FEES + BUFFER;

  return {
    breakdown: {
      buyTotal:    { sol: buyTotal,    label: `Dev buy (${walletCount} × ${perWalletSol} SOL)` },
      tokenATAs:   { sol: tokenATAs,   label: `Token accounts (${walletCount} × 0.00204 SOL)` },
      chainFees:   { sol: CHAIN_FEES,  label: "Obfuscation chain fees" },
      distFees:    { sol: distFees,    label: "Distribution tx fees" },
      depositFees: { sol: depositFees, label: "Vault deposit fees" },
      jitoTip:     { sol: JITO_TIP,   label: "Jito tip (vault fill)" },
      poolCost:    { sol: POOL_COST,   label: "Pool + vault creation" },
      buffer:      { sol: BUFFER,      label: "Safety buffer" },
    },
    totalSol,
    totalUsd:     totalSol * solPrice,
    perWalletSol,
    walletCount,
  };
}

// ── STATUS ─────────────────────────────────────────────────────────────────
export async function getStatus(chainHops: Keypair[] | null) {
  const { conn, bundle, walletsPath, walletCount } = getConfig();
  const [balance, solPrice] = await Promise.all([conn.getBalance(bundle.publicKey), getSolPrice()]);

  let generatedCount = 0;
  if (existsSync(walletsPath)) {
    try { generatedCount = (JSON.parse(readFileSync(walletsPath, "utf-8")) as any[]).length; } catch {}
  }

  let chain1Bal = 0;
  if (chainHops) {
    chain1Bal = (await conn.getBalance(chainHops[0].publicKey)) / LAMPORTS_PER_SOL;
  }

  return {
    configured:     true,
    depositAddress: bundle.publicKey.toBase58(),
    balanceSol:     balance / LAMPORTS_PER_SOL,
    balanceUsd:     (balance / LAMPORTS_PER_SOL) * solPrice,
    solPrice,
    walletCount,
    generatedCount,
    walletsReady:   generatedCount >= walletCount,
    chainReady:     !!chainHops,
    chainAddr1:     chainHops ? chainHops[0].publicKey.toBase58() : null,
    chain1Bal,
  };
}

// ── GENERATE WALLETS ────────────────────────────────────────────────────────
// If WALLET_SEED is set, keys are derived deterministically from it:
//   keypair[i] = fromSeed( sha256(WALLET_SEED + ":" + i) )
// Same seed → identical 100 wallets on every machine. This is how two people
// both end up with the exact same keys without sending files to each other.
// If no seed is set, falls back to random generation.
export function generateWallets(count: number, walletsPath: string): string[] {
  const seed = process.env.WALLET_SEED?.trim();

  const keypairs = Array.from({ length: count }, (_, i) => {
    if (seed) {
      const { createHash } = require("crypto");
      const digest: Buffer = createHash("sha256").update(`${seed}:${i}`).digest(); // 32 bytes
      return Keypair.fromSeed(Uint8Array.from(digest));
    }
    return Keypair.generate();
  });

  writeFileSync(walletsPath, JSON.stringify(keypairs.map(k => Array.from(k.secretKey)), null, 2));
  return keypairs.map(k => k.publicKey.toBase58());
}

export function loadWalletPubkeys(walletsPath: string): string[] {
  const raw: number[][] = JSON.parse(readFileSync(walletsPath, "utf-8"));
  return raw.map(s => Keypair.fromSecretKey(Uint8Array.from(s)).publicKey.toBase58());
}

// ── KEY EXPORT ─────────────────────────────────────────────────────────────
// Returns all wallet data: pubkey + secret key (as base58) for every wallet.
export function exportAllKeys(walletsPath: string): { pubkey: string; secretBase58: string }[] {
  const raw: number[][] = JSON.parse(readFileSync(walletsPath, "utf-8"));
  // bs58 v6 exports encode under .default when loaded via CommonJS require
  const bs58mod = require("bs58");
  const bs58 = bs58mod.default ?? bs58mod;
  return raw.map(s => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(s));
    // Encode secret as base58 (importable into Phantom / Solflare)
    return { pubkey: kp.publicKey.toBase58(), secretBase58: bs58.encode(kp.secretKey) };
  });
}

// ── CHAIN ADDRESSES ────────────────────────────────────────────────────────
export function generateChainAddresses(): Keypair[] {
  return Array.from({ length: 5 }, () => Keypair.generate());
}

// ── CHAIN RUN ──────────────────────────────────────────────────────────────
export async function runChain(
  hops: Keypair[],
  bundle: Keypair,
  conn: Connection,
  emit: (e: ChainEvent) => void,
): Promise<void> {
  const [a1, a2, a3, a4, a5] = hops;

  // Poll addr1 until funded
  while (true) {
    const bal    = await conn.getBalance(a1.publicKey);
    const needed = HOP_FEE * 9;
    if (bal > needed) break;
    emit({ type: "waiting", addr1: a1.publicKey.toBase58(), balance: bal, needed });
    await new Promise(r => setTimeout(r, 4000));
  }

  const startBal = await conn.getBalance(a1.publicKey);

  // Steps 1–3: SOL hops a1→a2→a3→a4
  const hopPairs = [
    { step: 1, from: a1, to: a2 },
    { step: 2, from: a2, to: a3 },
    { step: 3, from: a3, to: a4 },
  ];

  let carry = startBal;
  for (const { step, from, to } of hopPairs) {
    const amt = carry - HOP_FEE;
    emit({ type: "chain_step", step, label: "SOL hop", from: from.publicKey.toBase58(), to: to.publicKey.toBase58() });
    const sig = await sendTx(conn, solTx(from.publicKey, to.publicKey, amt), from);
    emit({ type: "chain_ok", step, sig });
    carry = amt;
  }

  // Step 4: a4 wraps SOL → WSOL, transfers WSOL to a5
  // a4 must reserve for: 2 ATA rents (ata4 + ata5) + gas it sends a5 to unwrap
  // with + its own tx fee. a5 has NO native SOL otherwise, so it can't pay the
  // close-account fee — that was the bug. We pre-fund a5 with A5_GAS native.
  const A5_GAS  = 5_000_000; // 0.005 SOL for a5's unwrap + forward tx fees
  const ata4    = getAssociatedTokenAddressSync(NATIVE_MINT, a4.publicKey);
  const ata5    = getAssociatedTokenAddressSync(NATIVE_MINT, a5.publicKey);
  const wrapAmt = carry - WSOL_RENT * 2 - A5_GAS - HOP_FEE;

  emit({ type: "chain_step", step: 4, label: "SOL → WSOL wrap + SPL transfer", from: a4.publicKey.toBase58(), to: a5.publicKey.toBase58() });
  const wrapTx = new Transaction().add(
    // create a4's WSOL account + fund it with the SOL we want to move
    createAssociatedTokenAccountInstruction(a4.publicKey, ata4, a4.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: a4.publicKey, toPubkey: ata4, lamports: wrapAmt }),
    createSyncNativeInstruction(ata4),
    // create a5's WSOL account (a4 pays rent) and move the WSOL token across
    createAssociatedTokenAccountInstruction(a4.publicKey, ata5, a5.publicKey, NATIVE_MINT),
    createTransferInstruction(ata4, ata5, a4.publicKey, wrapAmt),
    // give a5 native SOL so it can afford the unwrap + forward fees
    SystemProgram.transfer({ fromPubkey: a4.publicKey, toPubkey: a5.publicKey, lamports: A5_GAS }),
    // close a4's now-empty WSOL account, reclaim its rent back to a4
    createCloseAccountInstruction(ata4, a4.publicKey, a4.publicKey),
  );
  const wrapSig = await sendTx(conn, wrapTx, a4);
  emit({ type: "chain_ok", step: 4, sig: wrapSig });

  // Step 5: a5 unwraps WSOL → SOL (close sends WSOL + rent back to a5 native)
  emit({ type: "chain_step", step: 5, label: "WSOL unwrap", from: a5.publicKey.toBase58(), to: a5.publicKey.toBase58() });
  const unwrapTx = new Transaction().add(createCloseAccountInstruction(ata5, a5.publicKey, a5.publicKey));
  const unwrapSig = await sendTx(conn, unwrapTx, a5);
  emit({ type: "chain_ok", step: 5, sig: unwrapSig });

  // Step 6: a5 → bundle holder
  const a5Bal  = await conn.getBalance(a5.publicKey);
  const fwdAmt = a5Bal - HOP_FEE;
  emit({ type: "chain_step", step: 6, label: "SOL → bundle holder", from: a5.publicKey.toBase58(), to: bundle.publicKey.toBase58() });
  const fwdSig = await sendTx(conn, solTx(a5.publicKey, bundle.publicKey, fwdAmt), a5);
  emit({ type: "chain_ok", step: 6, sig: fwdSig });

  const bundleBal = await conn.getBalance(bundle.publicKey);
  emit({ type: "chain_done", bundleBalance: bundleBal / LAMPORTS_PER_SOL });
}

// ── RECOVER / SWEEP ─────────────────────────────────────────────────────────
// Pulls leftover SOL back to a destination address.
//   scope "bundle" → just the bundle holder
//   scope "all"    → bundle holder + every buyer wallet that has a balance
// This is how you reclaim the safety buffer + unused gas cushions.
export type SweepEvent =
  | { type: "sweep_start"; total: number }
  | { type: "sweep_wallet"; pubkey: string; amount: number; sig: string }
  | { type: "sweep_skip"; pubkey: string; reason: string }
  | { type: "sweep_done"; recovered: number }
  | { type: "error"; message: string };

export async function sweepWithCallback(
  destination: string,
  scope: "bundle" | "all",
  emit: (e: SweepEvent) => void,
): Promise<void> {
  const { conn, bundle, walletsPath } = getConfig();

  let dest: PublicKey;
  try { dest = new PublicKey(destination); }
  catch { emit({ type: "error", message: "Invalid destination address." }); return; }

  const MIN_FEE = 5_000; // leave nothing but the tx fee

  // Build the list of wallets to sweep
  const wallets: Keypair[] = [bundle];
  if (scope === "all" && existsSync(walletsPath)) {
    const raw: number[][] = JSON.parse(readFileSync(walletsPath, "utf-8"));
    raw.forEach(s => wallets.push(Keypair.fromSecretKey(Uint8Array.from(s))));
  }

  emit({ type: "sweep_start", total: wallets.length });

  let recovered = 0;

  // Sweep in small batches so we don't hammer the RPC
  const BATCH = 10;
  for (let i = 0; i < wallets.length; i += BATCH) {
    const chunk = wallets.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (kp) => {
      // Never sweep the destination into itself
      if (kp.publicKey.equals(dest)) {
        emit({ type: "sweep_skip", pubkey: kp.publicKey.toBase58(), reason: "is destination" });
        return;
      }
      const bal = await conn.getBalance(kp.publicKey);
      if (bal <= MIN_FEE) {
        emit({ type: "sweep_skip", pubkey: kp.publicKey.toBase58(), reason: "empty" });
        return;
      }
      const amt = bal - MIN_FEE;
      const tx  = solTx(kp.publicKey, dest, amt);
      tx.feePayer = kp.publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
      recovered += amt / LAMPORTS_PER_SOL;
      emit({ type: "sweep_wallet", pubkey: kp.publicKey.toBase58(), amount: amt, sig });
    }));
  }

  emit({ type: "sweep_done", recovered });
}

// ── DISTRIBUTE ─────────────────────────────────────────────────────────────
export async function distributeWithCallback(emit: (e: DistEvent) => void): Promise<void> {
  const { conn, bundle, walletsPath, walletCount } = getConfig();

  const raw: number[][] = JSON.parse(readFileSync(walletsPath, "utf-8"));
  const dests = raw.slice(0, walletCount).map(s =>
    Keypair.fromSecretKey(Uint8Array.from(s)).publicKey
  );

  const bundleBal = await conn.getBalance(bundle.publicKey);
  const reserve   = 10_000_000;
  const perWallet = Math.floor((bundleBal - reserve - DIST_FEE_BUF * dests.length) / dests.length);

  if (perWallet <= 0) {
    emit({ type: "error", message: `Not enough SOL. Have ${(bundleBal / LAMPORTS_PER_SOL).toFixed(4)} SOL for ${dests.length} wallets.` });
    return;
  }

  emit({ type: "dist_start", total: dests.length, perWallet });

  const MULTS = [0.90, 0.95, 1.00, 1.05, 1.10];
  const BATCH = 10;

  for (let i = 0; i < dests.length; i += BATCH) {
    const chunk = dests.slice(i, i + BATCH);
    // One blockhash shared across the batch — fast enough that it won't expire.
    const { blockhash } = await conn.getLatestBlockhash();
    await Promise.all(chunk.map(async (dest, j) => {
      const idx = i + j;
      const amt = Math.floor(perWallet * MULTS[idx % MULTS.length]) + DIST_FEE_BUF;
      const tx  = solTx(bundle.publicKey, dest, amt);
      tx.feePayer = bundle.publicKey;
      tx.recentBlockhash = blockhash;
      const sig = await sendAndConfirmTransaction(conn, tx, [bundle], { commitment: "confirmed" });
      emit({ type: "dist_wallet", index: idx, pubkey: dest.toBase58(), amount: amt, sig });
    }));
  }

  emit({ type: "dist_done" });
}
