/**
 * Stacks x402 paywall for Hono on Workers. Same route-map shape as
 * `@x402/hono`'s `paymentMiddleware`, priced in sBTC/STX/USDCx atomic units.
 */
import type { Context, MiddlewareHandler } from "hono";
import { X402_HEADERS } from "x402-stacks";
import {
  buildRequirements,
  resolveServerConfig,
  type ResolvedServerConfig,
  type StacksPaymentConfig
} from "./facilitator";
import { createPaymentGate, type PaymentGate, type PaymentReceipt } from "./gate";
import { assetId, type TokenSymbol } from "./constants";

export type PaidRouteConfig = {
  /** Price in the token's atomic unit (sats for sBTC). */
  price: bigint | number;
  /** Overrides the middleware-wide token for this route. */
  token?: TokenSymbol;
  description?: string;
  mimeType?: string;
};

/** Values set on the Hono context for paid requests: `c.get("x402Stacks")`. */
export type StacksPaymentVariables = {
  x402Stacks?: { payer?: string; receipt?: PaymentReceipt };
};

const encode = (v: unknown) => btoa(JSON.stringify(v));

function gateFor(
  resolved: ResolvedServerConfig,
  route: PaidRouteConfig,
  url: string
): PaymentGate {
  const cfg = route.token
    ? { ...resolved, asset: assetId(route.token, resolved.networkName) }
    : resolved;
  return createPaymentGate(cfg, buildRequirements(cfg, route.price), {
    url,
    description: route.description,
    mimeType: route.mimeType ?? "application/json"
  });
}

function respond402(
  c: Context,
  gate: PaymentGate,
  reason?: string,
  extra?: Record<string, unknown>
): Response {
  const body = gate.paymentRequired(reason, extra);
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      [X402_HEADERS.PAYMENT_REQUIRED]: encode(body)
    }
  });
}

async function runPaid(
  c: Context,
  next: () => Promise<void>,
  resolved: ResolvedServerConfig,
  gate: PaymentGate
): Promise<Response | void> {
  const token = c.req.header(X402_HEADERS.PAYMENT_SIGNATURE);
  if (!token) return respond402(c, gate);

  const v = await gate.verify(token);
  if (!v.ok) return respond402(c, gate, v.reason, v.extra);

  let receipt: PaymentReceipt | undefined;
  if (resolved.settle === "before-run") {
    const r = await gate.settle(v.payment);
    if (!r.ok) return respond402(c, gate, r.reason);
    receipt = r.receipt;
  }

  c.set("x402Stacks", { payer: receipt?.payer, receipt });
  await next();

  if (!receipt) {
    // Only charge for successful responses.
    if (c.res.status >= 400) return;
    const r = await gate.settle(v.payment);
    if (!r.ok) {
      c.res = respond402(c, gate, r.reason);
      return;
    }
    receipt = r.receipt;
    c.set("x402Stacks", { payer: receipt.payer, receipt });
  }
  c.res.headers.set(X402_HEADERS.PAYMENT_RESPONSE, encode(receipt));
}

/** Protect a single route: `app.get("/premium", requireStacksPayment(cfg, { price: 100 }), handler)`. */
export function requireStacksPayment(
  cfg: StacksPaymentConfig,
  route: PaidRouteConfig
): MiddlewareHandler {
  const resolved = resolveServerConfig(cfg);
  return async (c, next) =>
    runPaid(c, next, resolved, gateFor(resolved, route, c.req.path));
}

function matchRoute(pattern: string, method: string, path: string): boolean {
  const [m, p] = pattern.includes(" ") ? pattern.split(/\s+/, 2) : ["*", pattern];
  // Hono serves HEAD with the GET handler, so a GET price must cover HEAD too.
  const effective = method === "HEAD" ? "GET" : method;
  if (m !== "*" && m.toUpperCase() !== effective) return false;
  if (p.endsWith("/*")) return path === p.slice(0, -2) || path.startsWith(p.slice(0, -1));
  return p === path;
}

/**
 * Protect many routes at once:
 * `app.use(stacksPaymentMiddleware({ "GET /premium": { price: 100 } }, cfg))`.
 * Keys are `"METHOD /path"` (or just `"/path"`), with an optional trailing `/*`.
 */
export function stacksPaymentMiddleware(
  routes: Record<string, PaidRouteConfig>,
  cfg: StacksPaymentConfig
): MiddlewareHandler {
  const resolved = resolveServerConfig(cfg);
  const entries = Object.entries(routes);
  return async (c, next) => {
    const hit = entries.find(([pattern]) =>
      matchRoute(pattern, c.req.method, c.req.path)
    );
    if (!hit) return next();
    return runPaid(c, next, resolved, gateFor(resolved, hit[1], c.req.path));
  };
}
