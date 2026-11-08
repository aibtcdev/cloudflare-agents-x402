import { X402_HEADERS, type PaymentRequiredV2 } from "x402-stacks";
import { payFor, type StacksPayerConfig } from "./client";
import { encodePayment } from "./sign";

function decodeHeader(value: string | null): PaymentRequiredV2 | null {
  if (!value) return null;
  try {
    return JSON.parse(atob(value)) as PaymentRequiredV2;
  } catch {
    return null;
  }
}

/**
 * Wrap `fetch` so a 402 from a Stacks x402 endpoint is paid and retried once.
 * Workers-native counterpart to x402-stacks' `wrapAxiosWithPayment`.
 * Refusals (cap, declined, no compatible option) throw typed errors from
 * `@aibtc/x402-stacks-agents`.
 */
export function wrapFetchWithStacksPayment(
  fetchImpl: typeof fetch,
  cfg: StacksPayerConfig
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const retry = request.clone();
    const res = await fetchImpl(request);
    if (res.status !== 402) return res;

    let required = decodeHeader(res.headers.get(X402_HEADERS.PAYMENT_REQUIRED));
    if (!required) {
      try {
        required = (await res.clone().json()) as PaymentRequiredV2;
      } catch {
        return res;
      }
    }
    if (required?.x402Version !== 2 || !Array.isArray(required.accepts)) return res;

    const payment = await payFor(required, cfg);
    retry.headers.set(X402_HEADERS.PAYMENT_SIGNATURE, encodePayment(payment));
    return fetchImpl(retry);
  };
}

/** Decode the `payment-response` header of a paid response, if any. */
export function getPaymentResponse(res: Response): unknown {
  const value = res.headers.get(X402_HEADERS.PAYMENT_RESPONSE);
  if (!value) return null;
  try {
    return JSON.parse(atob(value));
  } catch {
    return null;
  }
}
