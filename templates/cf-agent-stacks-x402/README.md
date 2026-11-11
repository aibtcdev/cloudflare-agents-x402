# cf-agent-stacks-x402

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aibtcdev/cloudflare-agents-x402/tree/main/templates/cf-agent-stacks-x402)

Your own AI agent on Cloudflare that gets paid in **sBTC (sats) or STX** for every question, over x402. You write the prompt; it runs on [Workers AI](https://developers.cloudflare.com/workers-ai/). Payments settle through the aibtc x402 relay, built on [`@aibtc/x402-stacks-agents`](https://github.com/aibtcdev/cloudflare-agents-x402/tree/main/packages/x402-stacks-agents).

| Endpoint | What it does |
|---|---|
| `GET /ask?question=…` | Answers a question with your prompt. Costs `PRICE`. |
| `/mcp` | The same AI as an MCP tool `ask` (paid), plus a free `echo` tool |
| `/agent/<name>/…` | Optional: agents with their own wallets that **pay** for things. Needs `WALLET_KEK`. |

## Deploy in one click

Click **Deploy to Cloudflare** above. Cloudflare copies this template to your GitHub and asks for:

| Setting | What to enter |
|---|---|
| `AGENT_PROMPT` | What your agent does, e.g. `You are a Stacks smart-contract tutor.` |
| `AI_MODEL` | A [Workers AI model](https://developers.cloudflare.com/workers-ai/models/). The default is small and cheap. |
| `PRICE` | Price per question: **sats** for sBTC, **microSTX** for STX (1 STX = 1,000,000) |
| `TOKEN` | `sBTC` or `STX` |
| `PAY_TO` | Your Stacks address that receives payments (`ST…` testnet, `SP…` mainnet) |
| `STACKS_NETWORK` | `testnet` to try it, `mainnet` to earn real sats |

Then visit `https://<your-worker>.workers.dev/ask?question=hello`. You'll get a `402 Payment Required` describing the price, which is what x402 clients pay automatically.

## Good to know

- **Payment is taken before the AI runs**, so unpaid callers can't use up your Workers AI quota.
- **Workers AI is free up to 10,000 neurons a day**, about 285,000 answer tokens on the default model. Beyond that you need the Workers Paid plan. Price your answers above your cost. See [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- **Check your model's license** before charging for it. Llama models need a "Built with Llama" notice; Mistral models are Apache 2.0.
- **Don't open several accounts** to get more free neurons. Cloudflare's terms forbid it.
- Workers AI uses your Cloudflare account even in local development.

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars
# set PAY_TO in wrangler.jsonc to your Stacks address
npm run dev
```

```sh
curl -i "localhost:8787/ask?question=hello"                       # 402 + price
curl localhost:8787/agent/alice/wallet                            # needs WALLET_KEK in .dev.vars
curl -XPOST localhost:8787/agent/alice/tool -d '{"name":"ask","args":{"question":"hello"}}'
curl -XPOST localhost:8787/agent/alice/fetch -d '{"url":"http://localhost:8787/ask?question=hello"}'
```

The template installs `@aibtc/x402-stacks-agents` from its [GitHub release](https://github.com/aibtcdev/cloudflare-agents-x402/releases/tag/x402-stacks-agents-v0.1.0). To try unreleased library changes, build the package and run `npm install ../../packages/x402-stacks-agents --no-save` here.

## The paying agent (optional)

Receiving payments needs only `PAY_TO`. An agent that **pays** needs a private key, which is stored encrypted with `WALLET_KEK`. To enable it, keep a copy of the key, because changing it later locks existing wallets:

```sh
openssl rand -base64 32 | npx wrangler secret put WALLET_KEK
```

A new agent wallet starts empty. Send it sBTC **and a little STX** for fees (0.05 STX covers dozens of payments) at the address from `/agent/<name>/wallet`. In local dev you can instead uncomment `PAYER_PRIVATE_KEY` in `.dev.vars` and set a funded key. `MAX_SATS_PER_PAYMENT` caps what it auto-pays per call.
