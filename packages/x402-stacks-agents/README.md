# x402-stacks-agents

Stacks x402 payments (sBTC, STX, USDCx) for [Cloudflare's Agents SDK](https://developers.cloudflare.com/agents/tools/payments/x402/). It is the Stacks counterpart to `agents/x402`, which only supports EVM, and is built on [`x402-stacks`](https://github.com/tony1908/x402Stacks).

- Uses the same MCP transport as `agents/x402`: `_meta["x402/error"]`, `_meta["x402/payment"]` and `_meta["x402/payment-response"]`.
- Settles through the [aibtc x402 relay](https://github.com/aibtcdev/x402-sponsor-relay) by default. Its `/settle` (v1.34+) broadcasts **self-paid** transactions and does not sponsor them, so the paying wallet needs a little STX for fees (about 0.0013 STX per payment in Oct 2026). Payments carry a deny-mode post-condition, so they can't move more than the exact amount.
- `/settle` returns success once the transaction is **broadcast**, not confirmed, so the tool result is released while the payment is still in the mempool.
- Every payment carries an `x402:<nonce>` memo for on-chain attribution.
- Runs in Workers (`nodejs_compat`, which is the default from compat date 2026-08-04).

## Charge for an MCP tool

```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402Stacks } from "x402-stacks-agents/mcp";
import { z } from "zod";

export class PaidMCP extends McpAgent<Env> {
  server = withX402Stacks(new McpServer({ name: "paid", version: "1.0.0" }), {
    network: "testnet",            // or "mainnet" / "stacks:1"
    recipient: "ST...your-address",
    token: "sBTC"                  // default; "STX" | "USDCx"
  });

  async init() {
    // price is in atomic units: 100 sats
    this.server.paidTool("square", "Square a number", 100, { n: z.number() }, {},
      async ({ n }) => ({ content: [{ type: "text", text: String(n * n) }] }));
  }
}
```

**Settlement timing.** By default the payment is settled only after the tool succeeds, matching `agents/x402`. The relay's `/verify` checks the transaction's structure but **not the payer's balance**. An unfunded payer can therefore make the tool run, after which settlement fails and the result is withheld. For expensive tools, set `settle: "before-run"`.

## Pay from an agent

```ts
import { withX402StacksClient } from "x402-stacks-agents/mcp";

const client = withX402StacksClient(mcpClient, {
  privateKey: this.env.STACKS_PRIVATE_KEY,
  network: "testnet",
  maxAmount: { sBTC: 500n },                  // per-payment cap (default 1,000 sats)
  confirmationCallback: async (accepts) => true
});

// null = use confirmationCallback (or auto-pay within caps)
const res = await client.callTool(null, { name: "square", arguments: { n: 7 } });
```

## Pay an HTTP x402 endpoint

```ts
import { wrapFetchWithStacksPayment } from "x402-stacks-agents/fetch";

const paidFetch = wrapFetchWithStacksPayment(fetch, { privateKey, network: "mainnet" });
const res = await paidFetch("https://x402.aibtc.com/...");
```

## Options

| Option | Default | Notes |
|---|---|---|
| `facilitator` | aibtc relay for the network | A URL, or any `{ verify, settle }` implementation |
| `settle` | `"after-success"` | Set to `"before-run"` to charge before the tool executes |
| `maxAmount` | sBTC 1,000 sats · STX 1 STX · USDCx 0.10 | Per payment, in atomic units |
| `budget` | none | Cumulative spend cap (e.g. `{ total: { sBTC: 250n }, windowMs: 60_000 }`). Tracked in-memory per config object (`WeakMap`), resetting on Worker restart. Cloned configs (`{ ...cfg }`) maintain independent ledgers. |
| `getNonce` | fetched from the Stacks API | Supply it from agent state to avoid nonce collisions |
| `sponsored` | `false` | Build fee-0 transactions for a facilitator that co-signs as sponsor. The aibtc relay's `/settle` refuses them |
| `fee` | estimated | Fixed fee in microSTX per payment |
