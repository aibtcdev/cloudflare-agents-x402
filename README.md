# cloudflare-agents-x402

**One-click deployment of an x402 endpoint on Cloudflare that accepts sBTC and STX.**

Bitcoin payments for [Cloudflare Agents](https://developers.cloudflare.com/agents/). Agents can charge for their tools and pay for other agents' tools in **sBTC** (or STX / USDCx) on Stacks, using the [x402](https://developers.cloudflare.com/agents/tools/payments/x402/) pay-per-request standard.

Cloudflare's built-in `agents/x402` only supports EVM chains. This repo adds Stacks, settling through the [aibtc x402 relay](https://github.com/aibtcdev/x402-sponsor-relay).

## Deploy your own paid AI agent in one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aibtcdev/cloudflare-agents-x402/tree/main/templates/cf-agent-stacks-x402)

Write a prompt, pick a price in **sats (sBTC) or STX**, and enter the Stacks address that gets paid. You get an AI agent on Workers AI that charges for every question:

- `GET /ask?question=…`: paid answers over HTTP
- `/mcp`: the same AI as a paid MCP tool, for other agents
- `/agent/<name>/…`: optional agents with their own wallets that pay for things (set `WALLET_KEK` to enable)

See the [template README](templates/cf-agent-stacks-x402/README.md) for details and `curl` examples.

## What's in this repo

| Path | What it is |
|---|---|
| [`packages/x402-stacks-agents`](packages/x402-stacks-agents) | The library: `withX402Stacks` / `paidTool` to charge for MCP tools, `withX402StacksClient` to pay for them, a Hono paywall, and a paying `fetch` |
| [`templates/cf-agent-stacks-x402`](templates/cf-agent-stacks-x402) | The paid AI agent behind the Deploy button |

## Use the library in your own agent

It isn't on npm yet. Install it from the GitHub release:

```sh
npm install https://github.com/aibtcdev/cloudflare-agents-x402/releases/download/x402-stacks-agents-v0.1.0/aibtc-x402-stacks-agents-0.1.0.tgz
```

Usage is in the [package README](packages/x402-stacks-agents/README.md).

## Develop

```sh
npm install
npm run build
npm test
npm run typecheck
```
