import "dotenv/config";
import express from "express";
import { join, resolve } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  calcCost,
  getSolPrice,
  generateWallets,
  loadWalletPubkeys,
  exportAllKeys,
  distributeWithCallback,
  generateChainAddresses,
  runChain,
  getStatus,
  getConfig,
} from "./lib";

const app  = express();
const PORT = 3000;
const ENV_PATH = resolve(__dirname, ".env");

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── Chain keypairs held in memory for the lifetime of one chain run ─────────
let chainHops: Keypair[] | null = null;
let chainRunning = false;
let distRunning  = false;

// ── HELPERS ─────────────────────────────────────────────────────────────────
function isConfigured(): boolean {
  return !!(process.env.BUNDLE_KEY && process.env.BUNDLE_KEY.trim().length > 2);
}

function sse(res: express.Response) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();
  return (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function updateEnv(key: string, value: string) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  writeFileSync(ENV_PATH, content);
}

// ── SETUP: generate bundle holder key ───────────────────────────────────────
// No BUNDLE_KEY needed — this endpoint creates one.
app.post("/api/setup/generate", (_req, res) => {
  try {
    const kp      = Keypair.generate();
    const secret  = JSON.stringify(Array.from(kp.secretKey));
    const pubkey  = kp.publicKey.toBase58();

    // Set in process.env so server works immediately (no restart needed)
    process.env.BUNDLE_KEY = secret;

    // Persist to .env for future restarts
    updateEnv("BUNDLE_KEY", secret);

    res.json({ ok: true, pubkey });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATUS ───────────────────────────────────────────────────────────────────
app.get("/api/status", async (_req, res) => {
  if (!isConfigured()) { res.json({ configured: false }); return; }
  try {
    res.json(await getStatus(chainHops));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── KEY EXPORT ───────────────────────────────────────────────────────────────
// /api/keys/all   → every wallet (pubkey + secret)
// /api/keys/funded → only wallets that have a nonzero SOL balance
app.get("/api/keys/all", (_req, res) => {
  try {
    const { walletsPath } = getConfig();
    res.json(exportAllKeys(walletsPath));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/keys/funded", async (_req, res) => {
  try {
    const { conn, walletsPath } = getConfig();
    const all = exportAllKeys(walletsPath);
    const balances = await Promise.all(
      all.map(w => conn.getBalance(new (require("@solana/web3.js").PublicKey)(w.pubkey)))
    );
    const funded = all.filter((_, i) => balances[i] > 0).map((w, i) => ({
      ...w,
      solBalance: balances[all.indexOf(w)] / LAMPORTS_PER_SOL,
    }));
    res.json(funded);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── COST ────────────────────────────────────────────────────────────────────
app.get("/api/cost", async (req, res) => {
  try {
    const perWallet  = parseFloat(req.query.per as string) || 0.1;
    const walletCount = parseInt(req.query.count as string) || 100;
    const solPrice   = await getSolPrice();
    res.json(calcCost(perWallet, walletCount, solPrice));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GENERATE WALLETS ─────────────────────────────────────────────────────────
app.post("/api/wallets/generate", (_req, res) => {
  try {
    const { walletsPath, walletCount } = getConfig();
    const pubkeys = generateWallets(walletCount, walletsPath);
    res.json({ generated: pubkeys.length, pubkeys });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/wallets", (_req, res) => {
  try {
    const { walletsPath } = getConfig();
    res.json({ pubkeys: loadWalletPubkeys(walletsPath) });
  } catch {
    res.json({ pubkeys: [] });
  }
});

// ── CHAIN: generate 5 ephemeral addresses ───────────────────────────────────
app.post("/api/chain/generate", (_req, res) => {
  try {
    chainHops = generateChainAddresses();
    res.json({
      addrs: chainHops.map((k, i) => ({ index: i + 1, pubkey: k.publicKey.toBase58() })),
      depositHere: chainHops[0].publicKey.toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── CHAIN: run (SSE) ─────────────────────────────────────────────────────────
// Polls addr1 every 4s until funded, then runs the full chain automatically.
app.get("/api/chain/run", async (_req, res) => {
  if (!chainHops) { res.status(400).json({ error: "Generate chain addresses first." }); return; }
  if (chainRunning) { res.status(409).json({ error: "Chain already running." }); return; }

  const emit = sse(res);
  chainRunning = true;

  try {
    const { conn, bundle } = getConfig();
    await runChain(chainHops, bundle, conn, emit);
    emit({ type: "all_done" });
  } catch (e: any) {
    emit({ type: "error", message: e.message });
  } finally {
    chainRunning = false;
    chainHops    = null; // clear after use
    res.end();
  }
});

// ── DISTRIBUTE (SSE) ────────────────────────────────────────────────────────
app.get("/api/distribute", async (_req, res) => {
  if (distRunning) { res.status(409).json({ error: "Distribution already running." }); return; }

  const emit = sse(res);
  distRunning = true;

  try {
    await distributeWithCallback(emit);
    emit({ type: "all_done" });
  } catch (e: any) {
    emit({ type: "error", message: e.message });
  } finally {
    distRunning = false;
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  Wallet Funder  →  http://localhost:${PORT}  │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
});
