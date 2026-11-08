import { describe, expect, it, vi } from "vitest";
import { privateKeyToAddress, randomPrivateKey } from "@stacks/transactions";
import {
  PaymentCapError,
  assetId,
  decodePayment,
  getPaymentResponse,
  wrapFetchWithStacksPayment
} from "../src";

const payTo = privateKeyToAddress(randomPrivateKey(), "testnet");
const required = (amount: string) => ({
  x402Version: 2,
  resource: { url: "/premium" },
  accepts: [
    {
      scheme: "exact",
      network: "stacks:2147483648",
      amount,
      asset: assetId("sBTC", "testnet"),
      payTo,
      maxTimeoutSeconds: 300
    }
  ]
});

function server(amount: string) {
  return vi.fn(async (req: Request) => {
    const sig = req.headers.get("payment-signature");
    if (!sig) {
      return new Response(JSON.stringify(required(amount)), {
        status: 402,
        headers: { "payment-required": btoa(JSON.stringify(required(amount))) }
      });
    }
    const body = await req.text();
    return new Response(`paid:${body}`, {
      headers: { "payment-response": btoa(JSON.stringify({ success: true, sig: decodePayment(sig).accepted.amount })) }
    });
  });
}

const cfg = { privateKey: randomPrivateKey(), network: "testnet" as const, getNonce: async () => 0n, fee: 1000n };

describe("wrapFetchWithStacksPayment", () => {
  it("pays a 402 and retries with the same body", async () => {
    const inner = server("100");
    const f = wrapFetchWithStacksPayment(inner as unknown as typeof fetch, cfg);
    const res = await f("https://api.example/premium", { method: "POST", body: "q=1" });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(await res.text()).toBe("paid:q=1");
    expect(getPaymentResponse(res)).toEqual({ success: true, sig: "100" });
  });

  it("passes non-402 responses through untouched", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const f = wrapFetchWithStacksPayment(inner as unknown as typeof fetch, cfg);
    expect(await (await f("https://api.example/free")).text()).toBe("ok");
    expect(inner).toHaveBeenCalledOnce();
  });

  it("throws PaymentCapError above the cap and never retries", async () => {
    const inner = server("999999");
    const f = wrapFetchWithStacksPayment(inner as unknown as typeof fetch, cfg);
    await expect(f("https://api.example/premium")).rejects.toBeInstanceOf(PaymentCapError);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("enforces cumulative budget across multiple fetch calls", async () => {
    const inner = server("100");
    const budgetCfg = { ...cfg, budget: { total: { sBTC: 250n } } };
    const f = wrapFetchWithStacksPayment(inner as unknown as typeof fetch, budgetCfg);
    await f("https://api.example/premium");
    await f("https://api.example/premium");
    await expect(f("https://api.example/premium")).rejects.toThrow(/exceeds budget: 300 > 250/);
  });
});
