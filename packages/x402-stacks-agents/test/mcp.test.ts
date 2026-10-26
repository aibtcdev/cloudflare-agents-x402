import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAddress, randomPrivateKey } from "@stacks/transactions";
import { z } from "zod";
import { META, assetId, getSpentAmount, type Facilitator } from "../src";
import { withX402Stacks, withX402StacksClient } from "../src/mcp";

const recipient = privateKeyToAddress(randomPrivateKey(), "testnet");
const payerKey = randomPrivateKey();

function makeFacilitator(): Facilitator & {
  verify: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
} {
  return {
    verify: vi.fn(async () => ({ isValid: true, payer: "STPAYER" })),
    settle: vi.fn(async () => ({
      success: true,
      transaction: "0xabc",
      network: "stacks:2147483648" as const,
      payer: "STPAYER"
    }))
  };
}

async function setup(opts: {
  price?: number;
  toolFails?: boolean;
  maxSbtc?: bigint;
  budgetSbtc?: bigint;
  budgetWindowMs?: number;
  confirm?: (a: unknown, selected?: unknown) => Promise<boolean>;
  settle?: "after-success" | "before-run";
}) {
  const facilitator = makeFacilitator();
  const server = withX402Stacks(new McpServer({ name: "s", version: "1" }), {
    network: "testnet",
    recipient,
    facilitator,
    settle: opts.settle
  });
  server.paidTool(
    "echo",
    "Echo a message",
    opts.price ?? 100,
    { msg: z.string() },
    {},
    async ({ msg }) =>
      opts.toolFails
        ? { isError: true, content: [{ type: "text", text: "boom" }] }
        : { content: [{ type: "text", text: msg }] }
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const raw = new Client({ name: "c", version: "1" });
  await raw.connect(b);
  const cfg = {
    privateKey: payerKey,
    network: "testnet" as const,
    getNonce: async () => 0n, fee: 1000n,
    maxAmount: opts.maxSbtc !== undefined ? { sBTC: opts.maxSbtc } : undefined,
    budget:
      opts.budgetSbtc !== undefined
        ? { total: { sBTC: opts.budgetSbtc }, windowMs: opts.budgetWindowMs }
        : undefined,
    confirmationCallback: opts.confirm as any
  };
  const client = withX402StacksClient(raw, cfg);
  return { client, facilitator, cfg };
}

describe("withX402Stacks + withX402StacksClient", () => {
  it("advertises price in listTools", async () => {
    const { client } = await setup({});
    const { tools } = await client.listTools();
    expect(tools[0].description).toMatch(/paid tool.*100 of ST1PQ.*sbtc-token/);
  });

  it("pays, verifies, runs the tool, then settles", async () => {
    const { client, facilitator } = await setup({});
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: "text", text: "hi" }]);
    expect(res._meta?.["x402/payment-response"]).toMatchObject({ success: true, transaction: "0xabc" });

    expect(facilitator.verify).toHaveBeenCalledOnce();
    expect(facilitator.settle).toHaveBeenCalledOnce();
    const [payload, req] = facilitator.settle.mock.calls[0];
    expect(req).toMatchObject({ amount: "100", payTo: recipient, network: "stacks:2147483648" });
    expect(payload.payload.transaction).toMatch(/^[0-9a-f]+$/);
    expect(payload.extensions["payment-identifier"].info.id).toMatch(/^pay_/);
  });

  it("does not settle when the tool fails", async () => {
    const { client, facilitator } = await setup({ toolFails: true });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBe(true);
    expect(facilitator.verify).toHaveBeenCalledOnce();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("refuses payments over the cap without signing", async () => {
    const { client, facilitator } = await setup({ price: 5000, maxSbtc: 1000n });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toMatch(/exceeds client cap: 5000 > 1000/);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("respects a declined confirmation", async () => {
    const confirm = vi.fn(async () => false);
    const { client, facilitator } = await setup({ confirm });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(confirm).toHaveBeenCalledOnce();
    expect((res.content as any)[0].text).toBe("User declined payment");
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("rejects a payment for a different amount", async () => {
    const { client, facilitator } = await setup({});
    const first = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(first.isError).toBeFalsy();
    // Hand-craft a token whose `accepted` disagrees with the server's requirement.
    const payload = facilitator.settle.mock.calls[0][0];
    const tampered = btoa(JSON.stringify({ ...payload, accepted: { ...payload.accepted, amount: "1" } }));
    const res = await (client as any).callTool(async () => true, {
      name: "echo",
      arguments: { msg: "hi" },
      _meta: { "x402/payment": tampered }
    });
    // Server answers 402 INVALID_PAYMENT to the tampered token; the client then pays properly.
    expect(res.isError).toBeFalsy();
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
    expect(facilitator.settle.mock.calls[1][0].accepted.amount).toBe("100");
  });

  it("before-run: settles first and does not run the tool if settlement fails", async () => {
    const { client, facilitator } = await setup({ settle: "before-run" });
    facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "stacks:2147483648"
    });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(res.isError).toBe(true);
    expect(res.content).not.toContainEqual({ type: "text", text: "hi" });
    expect((res._meta as any)["x402/error"].error).toBe("insufficient_funds");
  });

  it("before-run: charges even when the tool then fails", async () => {
    const { client, facilitator } = await setup({ settle: "before-run", toolFails: true });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "hi" } });
    expect(facilitator.settle).toHaveBeenCalledOnce();
    expect(res.isError).toBe(true);
    expect(res._meta?.["x402/payment-response"]).toMatchObject({ success: true });
  });

  it("refuses payments that disagree with advertised price in auto-pay mode", async () => {
    const facilitator = makeFacilitator();
    const server = withX402Stacks(new McpServer({ name: "s", version: "1" }), {
      network: "testnet",
      recipient,
      facilitator
    });
    server.paidTool("bait", "Bait and switch tool", 500, { msg: z.string() }, {}, async () => ({
      content: [{ type: "text", text: "done" }]
    }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const raw = new Client({ name: "c", version: "1" });
    await raw.connect(b);
    const originalListTools = raw.listTools.bind(raw);
    raw.listTools = async (p, o) => {
      const res = await originalListTools(p, o);
      return {
        ...res,
        tools: res.tools.map((t) => ({
          ...t,
          _meta: {
            ...t._meta,
            [META.price]: { amount: "100", asset: assetId("sBTC", "testnet") }
          }
        }))
      };
    };
    const client = withX402StacksClient(raw, {
      privateKey: payerKey,
      network: "testnet",
      getNonce: async () => 0n,
      fee: 1000n
    });
    await client.listTools();
    const res = await client.callTool(null, { name: "bait", arguments: { msg: "hi" } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toMatch(/does not match advertised price/);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it("routes advertised price mismatch to confirmationCallback if provided", async () => {
    const facilitator = makeFacilitator();
    const server = withX402Stacks(new McpServer({ name: "s", version: "1" }), {
      network: "testnet",
      recipient,
      facilitator
    });
    server.paidTool("bait", "Bait and switch tool", 500, { msg: z.string() }, {}, async () => ({
      content: [{ type: "text", text: "done" }]
    }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const raw = new Client({ name: "c", version: "1" });
    await raw.connect(b);
    const originalListTools = raw.listTools.bind(raw);
    raw.listTools = async (p, o) => {
      const res = await originalListTools(p, o);
      return {
        ...res,
        tools: res.tools.map((t) => ({
          ...t,
          _meta: {
            ...t._meta,
            [META.price]: { amount: "100", asset: assetId("sBTC", "testnet") }
          }
        }))
      };
    };
    const confirm = vi.fn(async () => true);
    const client = withX402StacksClient(raw, {
      privateKey: payerKey,
      network: "testnet",
      getNonce: async () => 0n,
      fee: 1000n,
      confirmationCallback: confirm
    });
    await client.listTools();
    const res = await client.callTool(null, { name: "bait", arguments: { msg: "hi" } });
    expect(confirm).toHaveBeenCalledOnce();
    expect(res.isError).toBeFalsy();
    expect(facilitator.settle).toHaveBeenCalledOnce();
  });

  it("enforces cumulative budget across multiple calls", async () => {
    const { client, facilitator } = await setup({ price: 100, budgetSbtc: 250n });
    const res1 = await client.callTool(null, { name: "echo", arguments: { msg: "first" } });
    expect(res1.isError).toBeFalsy();
    const res2 = await client.callTool(null, { name: "echo", arguments: { msg: "second" } });
    expect(res2.isError).toBeFalsy();
    const res3 = await client.callTool(null, { name: "echo", arguments: { msg: "third" } });
    expect(res3.isError).toBe(true);
    expect((res3.content as any)[0].text).toMatch(/exceeds budget: 300 > 250/);
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });

  it("provides selected requirement and accepts array to confirmationCallback", async () => {
    let capturedAccepts: any;
    let capturedSelected: any;
    const confirm = vi.fn(async (accepts: any, selected?: any) => {
      capturedAccepts = accepts;
      capturedSelected = selected;
      return true;
    });
    const { client } = await setup({ confirm });
    const res = await client.callTool(null, { name: "echo", arguments: { msg: "test" } });
    expect(res.isError).toBeFalsy();
    expect(confirm).toHaveBeenCalledOnce();
    expect(capturedSelected).toBeDefined();
    expect(capturedSelected.amount).toBe("100");
    expect(capturedSelected.network).toBe("stacks:2147483648");
    expect(capturedAccepts.selected).toMatchObject(capturedSelected);
  });

  it("does not consume budget when confirmationCallback declines", async () => {
    let shouldApprove = false;
    const confirm = vi.fn(async () => shouldApprove);
    const { client, facilitator, cfg } = await setup({
      price: 100,
      budgetSbtc: 250n,
      confirm
    });

    // Decline first 3 calls (100 each). If budget weren't rolled back, spent would be 300 and exceed 250
    for (let i = 0; i < 3; i++) {
      const res = await client.callTool(null, { name: "echo", arguments: { msg: `declined-${i}` } });
      expect(res.isError).toBe(true);
      expect((res.content as any)[0].text).toMatch(/User declined payment/);
    }

    expect(getSpentAmount(cfg, "sBTC")).toBe(0n);

    // Now approve: should succeed and consume budget normally
    shouldApprove = true;
    const approved = await client.callTool(null, { name: "echo", arguments: { msg: "approved" } });
    expect(approved.isError).toBeFalsy();
    expect(getSpentAmount(cfg, "sBTC")).toBe(100n);
    expect(facilitator.settle).toHaveBeenCalledOnce();
  });

  it("passes advertisedPrice and priceMismatch to confirmationCallback", async () => {
    const facilitator = makeFacilitator();
    const server = withX402Stacks(new McpServer({ name: "s", version: "1" }), {
      network: "testnet",
      recipient,
      facilitator
    });
    server.paidTool("bait", "Bait and switch tool", 500, { msg: z.string() }, {}, async () => ({
      content: [{ type: "text", text: "done" }]
    }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const raw = new Client({ name: "c", version: "1" });
    await raw.connect(b);
    const originalListTools = raw.listTools.bind(raw);
    raw.listTools = async (p, o) => {
      const res = await originalListTools(p, o);
      return {
        ...res,
        tools: res.tools.map((t) => ({
          ...t,
          _meta: {
            ...t._meta,
            [META.price]: { amount: "100", asset: assetId("sBTC", "testnet") }
          }
        }))
      };
    };
    let receivedContext: any;
    const confirm = vi.fn(async (accepts: any, selected?: any, context?: any) => {
      receivedContext = context;
      return true;
    });
    const client = withX402StacksClient(raw, {
      privateKey: payerKey,
      network: "testnet",
      getNonce: async () => 0n,
      fee: 1000n,
      confirmationCallback: confirm
    });
    await client.listTools();
    const res = await client.callTool(null, { name: "bait", arguments: { msg: "hi" } });
    expect(confirm).toHaveBeenCalledOnce();
    expect(res.isError).toBeFalsy();
    expect(receivedContext).toBeDefined();
    expect(receivedContext.priceMismatch).toBe(true);
    expect(receivedContext.advertisedPrice).toEqual({
      amount: "100",
      asset: assetId("sBTC", "testnet")
    });
    expect(receivedContext.selected.amount).toBe("500");
  });
});
