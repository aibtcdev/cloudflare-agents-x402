import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { privateKeyToAddress, randomPrivateKey } from "@stacks/transactions";
import {
  getPaymentResponse,
  wrapFetchWithStacksPayment,
  type Facilitator
} from "../src";
import {
  requireStacksPayment,
  stacksPaymentMiddleware,
  type StacksPaymentVariables
} from "../src/hono";

const recipient = privateKeyToAddress(randomPrivateKey(), "testnet");
const payer = { privateKey: randomPrivateKey(), network: "testnet" as const, getNonce: async () => 0n, fee: 1000n };

function facilitator() {
  return {
    verify: vi.fn(async () => ({ isValid: true, payer: "STPAYER" })),
    settle: vi.fn(async () => ({
      success: true,
      transaction: "0xfeed",
      network: "stacks:2147483648" as const,
      payer: "STPAYER"
    }))
  } satisfies Facilitator;
}

function app(f: Facilitator, settle?: "after-success" | "before-run") {
  const a = new Hono<{ Variables: StacksPaymentVariables }>();
  a.use(
    stacksPaymentMiddleware(
      {
        "GET /premium": { price: 100, description: "Premium data" },
        "/files/*": { price: 50, token: "STX" }
      },
      { network: "testnet", recipient, facilitator: f, settle }
    )
  );
  a.get("/premium", (c) => c.json({ secret: 42, payer: c.get("x402Stacks")?.payer }));
  a.get("/files/:name", (c) => c.text(`file ${c.req.param("name")}`));
  a.get("/broken", requireStacksPayment({ network: "testnet", recipient, facilitator: f }, { price: 10 }), (c) =>
    c.json({ error: "nope" }, 500)
  );
  a.get("/free", (c) => c.text("free"));
  return a;
}

const viaApp = (a: Hono<any>) =>
  wrapFetchWithStacksPayment(((req: Request) => a.fetch(req)) as typeof fetch, payer);

describe("stacksPaymentMiddleware", () => {
  it("answers 402 with x402 v2 requirements in header and body", async () => {
    const res = await app(facilitator()).request("/premium");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(JSON.parse(atob(res.headers.get("payment-required")!))).toEqual(body);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "stacks:2147483648",
      amount: "100",
      payTo: recipient,
      asset: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token"
    });
  });

  it("charges HEAD on a GET-priced route (Hono runs the GET handler for HEAD)", async () => {
    const f = facilitator();
    const res = await app(f).request("/premium", { method: "HEAD" });
    expect(res.status).toBe(402);
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("leaves unpriced routes alone", async () => {
    expect(await (await app(facilitator()).request("/free")).text()).toBe("free");
  });

  it("end to end with the fetch client: pays, serves, settles, returns receipt", async () => {
    const f = facilitator();
    const res = await viaApp(app(f))("http://x/premium");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secret: 42 });
    expect(getPaymentResponse(res)).toMatchObject({ success: true, transaction: "0xfeed" });
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.settle).toHaveBeenCalledOnce();
  });

  it("per-route token override and wildcard match", async () => {
    const res = await app(facilitator()).request("/files/a.txt");
    const body = await res.json();
    expect(body.accepts[0]).toMatchObject({ amount: "50", asset: "STX" });
  });

  it("does not charge when the handler fails", async () => {
    const f = facilitator();
    const res = await viaApp(app(f))("http://x/broken");
    expect(res.status).toBe(500);
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("returns 402 when settlement fails after the handler ran", async () => {
    const f = facilitator();
    f.settle.mockResolvedValueOnce({ success: false, errorReason: "insufficient_funds", transaction: "", network: "stacks:2147483648" } as any);
    const res = await viaApp(app(f))("http://x/premium");
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("insufficient_funds");
  });

  it("before-run: exposes the payer to the handler", async () => {
    const res = await viaApp(app(facilitator(), "before-run"))("http://x/premium");
    expect(await res.json()).toEqual({ secret: 42, payer: "STPAYER" });
  });
});
