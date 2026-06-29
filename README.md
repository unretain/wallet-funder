# Wallet Funder

Local web tool to fund a fleet of Solana wallets through an obfuscation chain.

```
deposit → generate wallets → obfuscation chain → distribute
```

## What it does

1. **Cost calculator** — live SOL/USD breakdown of every fee
2. **Generate wallets** — creates N fresh keypairs, saved locally to `wallets.json`
3. **Obfuscation chain** — send SOL to a throwaway `addr1`; the server auto-chains it
   `addr1 → addr2 → addr3 → addr4 → [WSOL wrap] → addr5 → [unwrap] → bundle holder`
   The WSOL wrap/unwrap breaks the continuous SOL transfer trail.
4. **Distribute** — splits the bundle holder's balance across all wallets (±10% variation)
5. **Key export** — download all keys or just the funded ones (base58, importable to Phantom)

## Setup

```bash
npm install
cp .env.example .env      # add your RPC_URL
npm run web               # http://localhost:3000
```

The UI generates a bundle holder wallet on first run — you only need an `RPC_URL`.

## CLI mode

```bash
npm run cli -- 11         # run a full 11 SOL pass headless
```

## Security

`.env`, `wallets.json`, and exported key files are gitignored. **Never commit private keys.**
This runs entirely on `localhost` — keys never leave your machine.
