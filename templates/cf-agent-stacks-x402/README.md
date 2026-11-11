# cf-agent-stacks-x402

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aibtcdev/cloudflare-agents-x402/tree/main/templates/cf-agent-stacks-x402)

A Cloudflare Agents SDK starter where every agent has its **own Stacks wallet** and can both **charge** and **pay** in sBTC over x402. It is built on [`@aibtc/x402-stacks-agents`](https://github.com/aibtcdev/cloudflare-agents-x402/tree/main/packages/x402-stacks-agents). Payments settle through the aibtc x402 relay. They are self-paid, so an agent wallet needs sBTC to pay with plus a little STX for fees.

| Piece | What it shows |
|---|---|
| `PaidMCP` (McpAgent) | `paidTool("square", …, 100 sats)` plus a free `echo` tool |
| `GET /premium` | A Hono route paywalled at 100 sats with `stacksPaymentMiddleware` |
| `StacksAgent` (Agent) | Optional, enabled by setting `WALLET_KEK`. Creates its own wallet, encrypts the key with `WALLET_KEK` in its own SQLite, and pays `PaidMCP` and any x402 URL (auto-pays within `MAX_SATS_PER_PAYMENT`) |

Receiving payments needs only an address (`PAY_TO`). A private key, and so `WALLET_KEK`, is needed only for an agent that pays.

## Deploy in one click

Click **Deploy to Cloudflare** above. Cloudflare copies this template into a new repo on your GitHub, then asks for:

- `PAY_TO`: your Stacks address that receives payments (`ST…` on testnet, `SP…` on mainnet).
- `STACKS_NETWORK` and `MAX_SATS_PER_PAYMENT`: the defaults are fine to start.

That's enough to charge for `/premium` and the `square` MCP tool at `/mcp`. To also run the paying agent (`/agent/<name>/…`), add the wallet key and keep a copy, because changing it later locks existing agent wallets:

```sh
openssl rand -base64 32 | npx wrangler secret put WALLET_KEK
```

Then try it against your `*.workers.dev` URL using the `curl` commands below, replacing `localhost:8787`.

## Run locally

From a clone of this repo, npm workspaces link `@aibtc/x402-stacks-agents` to `packages/x402-stacks-agents`, which has to be built once:

```sh
# from the repo root
npm install
npm run build --workspace packages/x402-stacks-agents
cd templates/cf-agent-stacks-x402
cp .dev.vars.example .dev.vars      # for the paying agent: set WALLET_KEK=$(openssl rand -base64 32)
# set PAY_TO in wrangler.jsonc to the Stacks address that should receive payments
npm run dev
```

```sh
curl -i localhost:8787/premium                                    # 402 + requirements
curl localhost:8787/agent/alice/wallet                            # alice's own wallet + balances
curl -XPOST localhost:8787/agent/alice/tool -d '{"name":"echo","args":{"message":"hi"}}'
curl -XPOST localhost:8787/agent/alice/tool -d '{"name":"square","args":{"number":7}}'
curl -XPOST localhost:8787/agent/alice/fetch -d '{"url":"http://localhost:8787/premium"}'
```

A new agent wallet starts empty, so paid calls fail until it's funded. To make them settle, do one of the following:

- send sBTC **and a little STX** (0.05 STX covers dozens of payments) to the address returned by `/agent/<name>/wallet`, or
- uncomment `PAYER_PRIVATE_KEY` in `.dev.vars` and set it to a funded key.

Tested on mainnet on 2026-10-04: an agent paid 100 sats each for `square` and for `/premium`. See `RESEARCH.md` for the transaction IDs.

## Configure

| Var / secret | Purpose |
|---|---|
| `STACKS_NETWORK` | `testnet` (default) or `mainnet` |
| `PAY_TO` | Address that receives payments for `/premium` and `PaidMCP` |
| `MAX_SATS_PER_PAYMENT` | The agent's per-payment cap (default 1000) |
| `WALLET_KEK` (secret, optional) | 32-byte base64 key that encrypts every agent's private key. Needed only for the paying agent. **Rotating it locks existing wallets.** |
| `PAYER_PRIVATE_KEY` (secret, optional) | Dev only: pay from this key instead of the agent's wallet |

**Note:** with the default settlement mode, a paid tool runs before payment settles, because the relay's `/verify` doesn't check balances. An unfunded caller never gets the result, but the tool's work is still done. For expensive tools, pass `settle: "before-run"` to `withX402Stacks` or `stacksPaymentMiddleware`.

## Not yet included

- Onboarding (funding from a dedicated funder address, then aibtc identity registration) is the next step in [`RESEARCH.md`](../../RESEARCH.md).
- Human-in-the-loop payment confirmation: pass a callback instead of `null` to `callTool` (see Cloudflare's `x402-mcp` example).
