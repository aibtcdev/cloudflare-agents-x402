import { privateKeyToAddress, randomPrivateKey } from "@stacks/transactions";
import type { StacksNetworkName } from "@aibtc/x402-stacks-agents";

type Sql = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

export type WalletInfo = { address: string; network: StacksNetworkName; createdAt: number };

const HIRO: Record<StacksNetworkName, string> = {
  mainnet: "https://api.hiro.so",
  testnet: "https://api.testnet.hiro.so"
};

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function importKek(kekB64: string): Promise<CryptoKey> {
  const raw = unb64(kekB64);
  if (raw.length !== 32) throw new Error("WALLET_KEK must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * One Stacks wallet per agent instance. The private key is generated inside
 * the Durable Object and stored in its SQLite, encrypted (AES-GCM) with the
 * WALLET_KEK Worker secret. It never leaves the agent unencrypted.
 */
export class AgentWallet {
  constructor(
    private sql: Sql,
    private network: StacksNetworkName,
    private kek: string
  ) {
    this.sql`CREATE TABLE IF NOT EXISTS stacks_wallet (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      address TEXT NOT NULL,
      network TEXT NOT NULL,
      key_ct TEXT NOT NULL,
      key_iv TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
  }

  /** Create the wallet on first use; return its public info. */
  async ensure(): Promise<WalletInfo> {
    const existing = this.info();
    if (existing) return existing;

    const privateKey = randomPrivateKey();
    const address = privateKeyToAddress(privateKey, this.network);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(address) },
      await importKek(this.kek),
      new TextEncoder().encode(privateKey)
    );
    const createdAt = Date.now();
    this.sql`INSERT INTO stacks_wallet (id, address, network, key_ct, key_iv, created_at)
             VALUES (1, ${address}, ${this.network}, ${b64(ct)}, ${b64(iv)}, ${createdAt})`;
    return { address, network: this.network, createdAt };
  }

  info(): WalletInfo | null {
    const [row] = this.sql<{ address: string; network: string; created_at: number }>`
      SELECT address, network, created_at FROM stacks_wallet WHERE id = 1`;
    return row
      ? { address: row.address, network: row.network as StacksNetworkName, createdAt: row.created_at }
      : null;
  }

  async privateKey(): Promise<string> {
    const [row] = this.sql<{ address: string; key_ct: string; key_iv: string }>`
      SELECT address, key_ct, key_iv FROM stacks_wallet WHERE id = 1`;
    if (!row) throw new Error("Wallet not created yet");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(row.key_iv), additionalData: new TextEncoder().encode(row.address) },
      await importKek(this.kek),
      unb64(row.key_ct)
    );
    return new TextDecoder().decode(pt);
  }

  /**
   * Next nonce from the chain. Hiro's possible_next_nonce includes mempool
   * transactions, so a broadcast payment is counted as soon as it's accepted,
   * and a payment that was refused before broadcast leaves no gap.
   */
  async nextNonce(address: string): Promise<bigint> {
    const res = await fetch(`${HIRO[this.network]}/extended/v1/address/${address}/nonces`);
    if (!res.ok) throw new Error(`Nonce lookup failed: ${res.status}`);
    const { possible_next_nonce } = (await res.json()) as { possible_next_nonce: number };
    return BigInt(possible_next_nonce);
  }

  /** STX and sBTC balances from the Hiro API. */
  async balances(address: string): Promise<{ stx: string; sbtcSats: string }> {
    const res = await fetch(`${HIRO[this.network]}/extended/v1/address/${address}/balances`);
    if (!res.ok) throw new Error(`Balance lookup failed: ${res.status}`);
    const d = (await res.json()) as {
      stx: { balance: string };
      fungible_tokens: Record<string, { balance: string }>;
    };
    const sbtc = Object.entries(d.fungible_tokens ?? {}).find(([k]) =>
      k.endsWith(".sbtc-token::sbtc-token")
    );
    return { stx: d.stx.balance, sbtcSats: sbtc?.[1].balance ?? "0" };
  }
}
