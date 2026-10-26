import { privateKeyToAddress } from "@stacks/transactions";
import type {
  NetworkV2,
  PaymentPayloadV2,
  PaymentRequiredV2,
  PaymentRequirementsV2
} from "x402-stacks";
import {
  DEFAULT_MAX_AMOUNT,
  fromCAIP2,
  toCAIP2,
  tokenForAsset,
  type StacksNetworkName,
  type TokenSymbol
} from "./constants";
import { createPaymentPayload } from "./sign";

export type StacksPayerBudget = {
  /** Maximum cumulative spend per token in atomic units. */
  total?: Partial<Record<TokenSymbol, bigint>>;
  /** Sliding window duration in milliseconds. When omitted, budget accumulates indefinitely. */
  windowMs?: number;
};

export type ConfirmationContext = {
  selected: PaymentRequirementsV2;
  accepts: PaymentRequirementsV2[];
  /** Advertised price if available from tool catalog metadata. */
  advertisedPrice?: { amount: string; asset: string; network?: string };
  /** True if selected price/asset/network differs from advertised price. */
  priceMismatch?: boolean;
};

export type ConfirmationCallback = (
  accepts: PaymentRequirementsV2[] & {
    selected?: PaymentRequirementsV2;
    accepts?: PaymentRequirementsV2[];
  },
  selected?: PaymentRequirementsV2,
  context?: ConfirmationContext
) => Promise<boolean>;

export type StacksPayerConfig = {
  /** Hex private key of the paying wallet. */
  privateKey: string;
  network: StacksNetworkName | NetworkV2;
  /** Per-payment caps in atomic units. Merged over DEFAULT_MAX_AMOUNT. */
  maxAmount?: Partial<Record<TokenSymbol, bigint>>;
  /**
   * Cumulative spend budget across payments.
   * Note: The budget ledger is tracked in-memory per config object (WeakMap),
   * resetting when the Worker restarts. Cloned config objects ({ ...cfg })
   * maintain separate spend ledgers. Payments that fail after signing remain
   * counted towards budget for safety.
   */
  budget?: StacksPayerBudget;
  /** Called before every payment; return false to decline. */
  confirmationCallback?: ConfirmationCallback;
  /**
   * Build sponsored (fee 0) transactions for a sponsoring facilitator.
   * Default false: payments are self-paid, so the wallet needs a little STX.
   */
  sponsored?: boolean;
  /** Fixed fee in microSTX per payment. Estimated from the network when omitted. */
  fee?: bigint;
  /**
   * Supply the account nonce (e.g. from agent state, so concurrent payments
   * don't collide). Fetched from the Stacks API when omitted.
   */
  getNonce?: (address: string) => Promise<bigint>;
};

export class PaymentDeclinedError extends Error {}
export class PaymentCapError extends Error {}
export class AdvertisedPriceMismatchError extends Error {}
export class NoCompatibleRequirementError extends Error {}

type SpendEntry = { amount: bigint; timestamp: number };
const spendLedgers = new WeakMap<object, Map<TokenSymbol, SpendEntry[]>>();

function recordSpend(
  cfg: StacksPayerConfig,
  token: TokenSymbol,
  amount: bigint,
  now: number
): SpendEntry {
  let tokenMap = spendLedgers.get(cfg);
  if (!tokenMap) {
    tokenMap = new Map();
    spendLedgers.set(cfg, tokenMap);
  }
  let entries = tokenMap.get(token);
  if (!entries) {
    entries = [];
    tokenMap.set(token, entries);
  }
  const entry: SpendEntry = { amount, timestamp: now };
  entries.push(entry);
  return entry;
}

function rollbackSpend(
  cfg: StacksPayerConfig,
  token: TokenSymbol,
  entry: SpendEntry
): void {
  const tokenMap = spendLedgers.get(cfg);
  if (!tokenMap) return;
  const entries = tokenMap.get(token);
  if (!entries) return;
  const index = entries.indexOf(entry);
  if (index !== -1) {
    entries.splice(index, 1);
  }
}

function getSpent(
  cfg: StacksPayerConfig,
  token: TokenSymbol,
  now: number,
  windowMs?: number
): bigint {
  const tokenMap = spendLedgers.get(cfg);
  if (!tokenMap) return 0n;
  const entries = tokenMap.get(token);
  if (!entries || entries.length === 0) return 0n;

  if (windowMs !== undefined && windowMs > 0) {
    const cutoff = now - windowMs;
    while (entries.length > 0 && entries[0].timestamp < cutoff) {
      entries.shift();
    }
  }
  return entries.reduce((acc, curr) => acc + curr.amount, 0n);
}

export function getSpentAmount(
  cfg: StacksPayerConfig,
  token: TokenSymbol,
  windowMs?: number
): bigint {
  return getSpent(cfg, token, Date.now(), windowMs ?? cfg.budget?.windowMs);
}

export function resetSpentAmount(cfg: StacksPayerConfig): void {
  spendLedgers.delete(cfg);
}

export function payerAddress(cfg: StacksPayerConfig): string {
  return privateKeyToAddress(cfg.privateKey, fromCAIP2(toCAIP2(cfg.network)));
}

/**
 * Pick the first requirement on our network in a token we can sign, enforce
 * the cap and budget, ask for confirmation, then sign. Throws typed errors on refusal.
 */
export async function payFor(
  required: PaymentRequiredV2,
  cfg: StacksPayerConfig,
  confirm = cfg.confirmationCallback,
  expectedPrice?: { amount: string; asset: string; network?: string }
): Promise<PaymentPayloadV2> {
  const network = toCAIP2(cfg.network);
  const networkName = fromCAIP2(network);
  const caps = { ...DEFAULT_MAX_AMOUNT, ...cfg.maxAmount };

  // Work on a copy so nothing the server or callback holds can alter what we sign.
  const accepts = structuredClone(required.accepts ?? []);
  const candidates = accepts.filter(
    (r) =>
      r.scheme === "exact" &&
      r.network === network &&
      tokenForAsset(r.asset, networkName) !== undefined
  );
  if (candidates.length === 0) {
    throw new NoCompatibleRequirementError(
      `No payable Stacks requirement for ${network}. Offered: ${accepts
        .map((r) => `${r.scheme}/${r.network}/${r.asset}`)
        .join(", ")}`
    );
  }

  const selected = candidates[0];
  const token = tokenForAsset(selected.asset, networkName)!;
  let amount: bigint;
  try {
    amount = BigInt(selected.amount);
  } catch {
    throw new NoCompatibleRequirementError(
      `Malformed amount: ${selected.amount}`
    );
  }
  if (amount < 0n) {
    throw new NoCompatibleRequirementError(`Negative amount: ${amount}`);
  }
  if (amount > caps[token]) {
    throw new PaymentCapError(
      `Payment exceeds client cap: ${amount} > ${caps[token]} (${token})`
    );
  }

  let priceMismatch = false;
  if (expectedPrice) {
    priceMismatch =
      selected.amount !== expectedPrice.amount ||
      selected.asset !== expectedPrice.asset ||
      (expectedPrice.network !== undefined && selected.network !== expectedPrice.network);
    if (priceMismatch && !confirm) {
      throw new AdvertisedPriceMismatchError(
        `Payment amount (${selected.amount} of ${selected.asset}) does not match advertised price (${expectedPrice.amount} of ${expectedPrice.asset})`
      );
    }
  }

  let spendEntry: SpendEntry | undefined;
  if (cfg.budget?.total && cfg.budget.total[token] !== undefined) {
    const budgetLimit = cfg.budget.total[token]!;
    const now = Date.now();
    const spent = getSpent(cfg, token, now, cfg.budget.windowMs);
    if (spent + amount > budgetLimit) {
      throw new PaymentCapError(
        `Payment exceeds budget: ${spent + amount} > ${budgetLimit} (${token})`
      );
    }
    spendEntry = recordSpend(cfg, token, amount, now);
  }

  try {
    if (confirm) {
      const acceptsClone = structuredClone(accepts);
      const selectedClone = structuredClone(selected);
      const enriched = Object.assign(acceptsClone, {
        selected: selectedClone,
        accepts: acceptsClone
      });
      const context: ConfirmationContext = {
        selected: selectedClone,
        accepts: acceptsClone,
        advertisedPrice: expectedPrice,
        priceMismatch
      };
      if (!(await confirm(enriched, selectedClone, context))) {
        throw new PaymentDeclinedError("User declined payment");
      }
    }

    return await createPaymentPayload(required, selected, {
      privateKey: cfg.privateKey,
      sponsored: cfg.sponsored,
      fee: cfg.fee,
      nonce: cfg.getNonce ? await cfg.getNonce(payerAddress(cfg)) : undefined
    });
  } catch (err) {
    if (spendEntry) {
      rollbackSpend(cfg, token, spendEntry);
    }
    throw err;
  }
}
