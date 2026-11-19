import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { privateKeyToAddress, randomPrivateKey } from "@stacks/transactions";
import { decodePayment, encodePayment } from "../src";
import { requireStacksPayment } from "../src/hono";

const recipient = privateKeyToAddress(randomPrivateKey(), "testnet");
const description = "Premium data — real-time ₿ prices";

describe("non-Latin1 text in payment descriptions", () => {
  it("serves a 402 with a decodable payment-required header", async () => {
    const app = new Hono();
    app.get(
      "/p",
      requireStacksPayment(
        { network: "testnet", recipient, facilitator: {} as any },
        { price: 10, description }
      ),
      (c) => c.text("ok")
    );
    const res = await app.request("/p");
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const bytes = Uint8Array.from(atob(header!), (c) => c.charCodeAt(0));
    const body = JSON.parse(new TextDecoder().decode(bytes));
    expect(body.resource.description).toBe(description);
  });

  it("round-trips a payment payload carrying the description", () => {
    const payload: any = {
      x402Version: 2,
      resource: { url: "x", description },
      accepted: {},
      payload: { transaction: "00" }
    };
    expect(decodePayment(encodePayment(payload))).toEqual(payload);
  });
});
