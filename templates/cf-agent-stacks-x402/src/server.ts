import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";
import {
  wrapFetchWithStacksPayment,
  type PaymentReceipt,
  type StacksNetworkName,
  type StacksPayerConfig
} from "@aibtc/x402-stacks-agents";
import { withX402Stacks, withX402StacksClient } from "@aibtc/x402-stacks-agents/mcp";
import { stacksPaymentMiddleware, type StacksPaymentVariables } from "@aibtc/x402-stacks-agents/hono";
import { AgentWallet, NO_KEK } from "./wallet";

const network = (process.env.STACKS_NETWORK ?? "testnet") as StacksNetworkName;

// --- 0. The AI you sell. Set AGENT_PROMPT, AI_MODEL, PRICE and TOKEN in wrangler.jsonc ---

const price = Number(process.env.PRICE);

const payment = {
  network,
  recipient: process.env.PAY_TO as string,
  token: process.env.TOKEN as "sBTC" | "STX",
  settle: "before-run" as const // take the payment before running the AI
};

async function askAI(env: Env, question: string) {
  const result = await env.AI.run(env.AI_MODEL, {
    messages: [
      { role: "system", content: env.AGENT_PROMPT },
      { role: "user", content: question }
    ],
    max_tokens: 512
  });
  return String(result.response);
}

// --- 1. MCP server that charges for the AI ---

export class PaidMCP extends McpAgent<Env> {
  server = withX402Stacks(new McpServer({ name: "PaidMCP", version: "1.0.0" }), payment);

  async init() {
    this.server.paidTool(
      "ask",
      "Ask this agent a question",
      price,
      { question: z.string() },
      {},
      async ({ question }) => ({ content: [{ type: "text", text: await askAI(this.env, question) }] })
    );

    this.server.registerTool(
      "echo",
      { description: "Echo a message (free)", inputSchema: { message: z.string() } },
      async ({ message }) => ({ content: [{ type: "text", text: message }] })
    );
  }
}

// --- 2. Agent with its own Stacks wallet that pays for tools and HTTP ---

export class StacksAgent extends Agent<Env> {
  private wallet = new AgentWallet(this.sql.bind(this), network, this.env.WALLET_KEK);
  private mcpClient?: ReturnType<typeof withX402StacksClient>;

  private async payer(): Promise<StacksPayerConfig> {
    // PAYER_PRIVATE_KEY lets you test with an already-funded wallet in dev.
    const devKey = this.env.PAYER_PRIVATE_KEY;
    const privateKey = devKey || (await this.wallet.privateKey());
    return {
      privateKey,
      network,
      maxAmount: { sBTC: BigInt(this.env.MAX_SATS_PER_PAYMENT ?? "1000") },
      getNonce: devKey ? undefined : (address) => this.wallet.nextNonce(address)
    };
  }

  async onStart() {
    if (!this.env.WALLET_KEK) return console.log(`[StacksAgent ${this.name}] ${NO_KEK}`);
    const { address } = await this.wallet.ensure();
    console.log(`[StacksAgent ${this.name}] wallet ${address} (${network})`);
  }

  private async paidTools() {
    if (!this.mcpClient) {
      const { id } = await this.addMcpServer("paid-mcp", this.env.PaidMCP);
      this.mcpClient = withX402StacksClient(
        this.mcp.mcpConnections[id].client,
        await this.payer()
      );
    }
    return this.mcpClient;
  }

  @callable()
  async getWallet() {
    const info = await this.wallet.ensure();
    const balances = await this.wallet.balances(info.address).catch(() => null);
    return { ...info, balances };
  }

  /** Call a tool on PaidMCP, paying in sBTC if it asks (auto-pay within MAX_SATS_PER_PAYMENT). */
  @callable()
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; isError: boolean; payment: PaymentReceipt | null }> {
    const client = await this.paidTools();
    const res = await client.callTool(null, { name, arguments: args });
    const first = res.content[0];
    return {
      text: first?.type === "text" ? first.text : JSON.stringify(res.content),
      isError: res.isError ?? false,
      payment: (res._meta?.["x402/payment-response"] as PaymentReceipt | undefined) ?? null
    };
  }

  /** Fetch any Stacks x402 HTTP endpoint, paying if it returns 402. */
  @callable()
  async fetchPaid(url: string): Promise<{ status: number; body: string; payment: string | null }> {
    const paidFetch = wrapFetchWithStacksPayment(fetch, await this.payer());
    const res = await paidFetch(url);
    return { status: res.status, body: await res.text(), payment: res.headers.get("payment-response") };
  }
}

// --- 3. HTTP: a paywalled route, plus JSON endpoints to drive the agent ---

const app = new Hono<{ Bindings: Env; Variables: StacksPaymentVariables }>();

app.use(stacksPaymentMiddleware({ "GET /ask": { price, description: "Ask this agent a question" } }, payment));

app.get("/ask", async (c) => c.json({ answer: await askAI(c.env, c.req.query("question") ?? "") }));

// The paying agent needs WALLET_KEK; charging (/ask, /mcp) does not.
app.use("/agent/*", async (c, next) =>
  c.env.WALLET_KEK ? next() : c.json({ error: NO_KEK }, 503)
);

const agent = (c: { env: Env; req: { param: (k: "name") => string } }) =>
  getAgentByName(c.env.StacksAgent, c.req.param("name"));

app.get("/agent/:name/wallet", async (c) => c.json(await (await agent(c)).getWallet()));
app.post("/agent/:name/tool", async (c) => {
  const { name, args } = await c.req.json<{ name: string; args: Record<string, unknown> }>();
  return c.json(await (await agent(c)).callTool(name, args ?? {}));
});
app.post("/agent/:name/fetch", async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  return c.json(await (await agent(c)).fetchPaid(url));
});

app.all("/mcp", (c) => PaidMCP.serve("/mcp", { binding: "PaidMCP" }).fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.all("/agents/*", async (c) => (await routeAgentRequest(c.req.raw, c.env)) ?? c.notFound());

export default app;
