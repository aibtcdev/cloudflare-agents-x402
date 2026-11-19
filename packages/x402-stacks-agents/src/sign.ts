import {
  Cl,
  Pc,
  makeContractCall,
  makeSTXTokenTransfer,
  privateKeyToAddress
} from "@stacks/transactions";
import {
  createFacilitatorMemo,
  createFacilitatorNonce,
  type PaymentPayloadV2,
  type PaymentRequiredV2,
  type PaymentRequirementsV2
} from "x402-stacks";
import { decodeBase64Json, encodeBase64Json } from "./base64";
import { TOKEN_CONTRACTS, fromCAIP2, tokenForAsset } from "./constants";

export type StacksSigner = {
  privateKey: string;
  /**
   * Build a sponsored (fee 0) transaction for a sponsor to co-sign. Off by
   * default: the aibtc relay's /settle (v1.34+) only accepts self-paid or
   * already sponsor-signed transactions and refuses an empty sponsor slot.
   * Also enabled when the requirement advertises `extra.feePayer`.
   */
  sponsored?: boolean;
  /** Account nonce. Fetched from the Stacks API when omitted. */
  nonce?: bigint;
  /** Fee in microSTX for self-paid transactions. Estimated when omitted. */
  fee?: bigint;
};

/**
 * Sign (never broadcast) a payment for one requirement. Mirrors
 * x402-stacks' internal signPaymentV2 using @stacks/transactions v7,
 * including the `x402:<nonce>` memo used for on-chain attribution.
 */
export async function signPayment(
  req: PaymentRequirementsV2,
  signer: StacksSigner
): Promise<string> {
  const network = fromCAIP2(req.network);
  const token = tokenForAsset(req.asset, network);
  if (!token) throw new Error(`Unsupported asset: ${req.asset}`);

  const amount = BigInt(req.amount);
  const sender = privateKeyToAddress(signer.privateKey, network);
  const memo = createFacilitatorMemo(createFacilitatorNonce());
  const sponsored =
    signer.sponsored === true || typeof req.extra?.feePayer === "string";
  const fee = sponsored
    ? { sponsored: true, fee: 0n }
    : signer.fee !== undefined
      ? { fee: signer.fee }
      : {};
  const nonce = signer.nonce !== undefined ? { nonce: signer.nonce } : {};

  if (token === "STX") {
    const tx = await makeSTXTokenTransfer({
      recipient: req.payTo,
      amount,
      memo,
      senderKey: signer.privateKey,
      network,
      ...fee,
      ...nonce
    });
    return tx.serialize();
  }

  const c = TOKEN_CONTRACTS[network][token];
  const tx = await makeContractCall({
    contractAddress: c.address,
    contractName: c.name,
    functionName: "transfer",
    functionArgs: [
      Cl.uint(amount),
      Cl.principal(sender),
      Cl.principal(req.payTo),
      Cl.some(Cl.bufferFromAscii(memo))
    ],
    // Deny mode: the tx can't move more than `amount` of the token.
    postConditionMode: "deny",
    postConditions: [
      Pc.principal(sender)
        .willSendEq(amount)
        .ft(`${c.address}.${c.name}`, c.assetName)
    ],
    senderKey: signer.privateKey,
    network,
    ...fee,
    ...nonce
  });
  return tx.serialize();
}

export async function createPaymentPayload(
  required: Pick<PaymentRequiredV2, "resource" | "extensions">,
  accepted: PaymentRequirementsV2,
  signer: StacksSigner
): Promise<PaymentPayloadV2> {
  return {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { transaction: await signPayment(accepted, signer) },
    ...(required.extensions ? { extensions: required.extensions } : {})
  };
}

export function encodePayment(payload: PaymentPayloadV2): string {
  return encodeBase64Json(payload);
}

export function decodePayment(token: string): PaymentPayloadV2 {
  return decodeBase64Json<PaymentPayloadV2>(token);
}
