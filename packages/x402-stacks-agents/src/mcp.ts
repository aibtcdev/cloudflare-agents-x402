/**
 * Stacks x402 for MCP: a drop-in counterpart to Cloudflare's `agents/x402`
 * (`withX402` / `withX402Client`) that charges and pays in sBTC, STX or USDCx.
 * Same transport: 402 as a tool result with `_meta["x402/error"]`, payment
 * retried in `_meta["x402/payment"]`, settlement only after the tool succeeds.
 */
import type {
  McpServer,
  RegisteredTool,
  ToolCallback
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolRequest,
  CallToolResult,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ZodRawShape } from "zod";
import type {
  PaymentPayloadV2,
  PaymentRequiredV2,
  PaymentRequirementsV2
} from "x402-stacks";
import { META } from "./constants";
import {
  buildRequirements,
  resolveServerConfig,
  type StacksPaymentConfig
} from "./facilitator";
import { createPaymentGate, type PaymentReceipt } from "./gate";
import {
  AdvertisedPriceMismatchError,
  NoCompatibleRequirementError,
  PaymentCapError,
  PaymentDeclinedError,
  payFor,
  type StacksPayerConfig
} from "./client";
import { encodePayment } from "./sign";

/*
  ======= SERVER SIDE =======
*/

export interface X402StacksAugmentedServer {
  /**
   * Register a tool that must be paid for before it runs.
   * @param price amount in the configured token's atomic unit (sats for sBTC,
   * microSTX for STX, micro-USDCx for USDCx).
   */
  paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    price: bigint | number,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): RegisteredTool;
}

export function withX402Stacks<T extends McpServer>(
  server: T,
  cfg: StacksPaymentConfig
): T & X402StacksAugmentedServer {
  const resolved = resolveServerConfig(cfg);

  function paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    price: bigint | number,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): RegisteredTool {
    const gate = createPaymentGate(resolved, buildRequirements(resolved, price), {
      url: `x402://${name}`,
      description,
      mimeType: "application/json"
    });
    const { requirements } = gate;

    const paymentRequired = (
      reason?: string,
      extra?: Record<string, unknown>
    ): CallToolResult => {
      const payload = gate.paymentRequired(reason, extra);
      return {
        isError: true,
        _meta: { [META.error]: payload },
        content: [{ type: "text", text: JSON.stringify(payload) }]
      };
    };

    return server.registerTool(
      name,
      {
        description,
        inputSchema: paramsSchema,
        annotations,
        _meta: {
          [META.paymentRequired]: true,
          [META.price]: {
            amount: requirements.amount,
            asset: requirements.asset,
            network: requirements.network
          }
        }
      },
      (async (args: unknown, extra: Parameters<ToolCallback<Args>>[1]) => {
        const headers = (extra?.requestInfo?.headers ?? {}) as Record<
          string,
          string | string[] | undefined
        >;
        const token =
          (extra?._meta?.[META.payment] as string | undefined) ??
          headers["payment-signature"] ??
          headers["PAYMENT-SIGNATURE"];
        if (!token || typeof token !== "string") return paymentRequired();

        const v = await gate.verify(token);
        if (!v.ok) return paymentRequired(v.reason, v.extra);

        let receipt: PaymentReceipt | undefined;
        if (resolved.settle === "before-run") {
          const r = await gate.settle(v.payment);
          if (!r.ok) return paymentRequired(r.reason);
          receipt = r.receipt;
        }

        let result: CallToolResult;
        let failed = false;
        try {
          result = await (cb as (a: unknown, e: unknown) => Promise<CallToolResult>)(
            args,
            extra
          );
          failed = !!result?.isError;
        } catch (e) {
          failed = true;
          result = {
            isError: true,
            content: [{ type: "text", text: `Tool execution failed: ${String(e)}` }]
          };
        }

        if (!receipt) {
          if (failed) return result;
          const r = await gate.settle(v.payment);
          if (!r.ok) return paymentRequired(r.reason);
          receipt = r.receipt;
        }
        result._meta ??= {};
        result._meta[META.paymentResponse] = receipt;
        return result;
      }) as unknown as ToolCallback<Args>
    );
  }

  Object.defineProperty(server, "paidTool", {
    value: paidTool,
    writable: false,
    enumerable: false,
    configurable: true
  });
  return server as T & X402StacksAugmentedServer;
}

/*
  ======= CLIENT SIDE =======
*/

type ConfirmationCallback = (
  accepts: PaymentRequirementsV2[]
) => Promise<boolean>;

export interface X402StacksAugmentedClient {
  /**
   * Call a tool, paying automatically if it answers with a Stacks 402.
   * @param confirm per-call confirmation; `null` falls back to the configured
   * `confirmationCallback` (or auto-pay within caps if none).
   */
  callTool(
    confirm: ConfirmationCallback | null,
    params: CallToolRequest["params"],
    options?: RequestOptions
  ): Promise<CallToolResult>;
}

/**
 * Any MCP client: SDK v1 `Client` (`callTool(params, schema?, options?)`) or
 * `@modelcontextprotocol/client` v2 (`callTool(params, options?)`), which is
 * what the Agents SDK's `this.mcp.mcpConnections[id].client` is.
 */
export type McpClientLike = {
  // biome-ignore lint: both SDK generations must be accepted
  callTool(...args: any[]): Promise<any>;
  // biome-ignore lint: both SDK generations must be accepted
  listTools(...args: any[]): Promise<any>;
};

export function withX402StacksClient<T extends McpClientLike>(
  client: T,
  cfg: StacksPayerConfig
): Omit<T, "callTool"> & X402StacksAugmentedClient {
  const isV2 =
    typeof (client as { getProtocolEra?: unknown }).getProtocolEra === "function";
  const originalCallTool = client.callTool.bind(client);
  const originalListTools = client.listTools.bind(client);
  const invoke = (params: CallToolRequest["params"], options?: RequestOptions) =>
    (isV2
      ? originalCallTool(params, options)
      : originalCallTool(params, undefined, options)) as Promise<CallToolResult>;

  const advertisedPrices = new Map<
    string,
    { amount: string; asset: string; network?: string }
  >();

  const listTools = async (params?: unknown, options?: unknown) => {
    const res = (await originalListTools(params, options)) as {
      tools: Array<{
        name?: string;
        description?: string;
        _meta?: Record<string, unknown>;
      }>;
    };
    return {
      ...res,
      tools: res.tools.map((tool) => {
        const price = tool._meta?.[META.price] as
          | { amount: string; asset: string; network?: string }
          | undefined;
        if (tool.name && price) {
          advertisedPrices.set(tool.name, price);
        }
        if (!tool._meta?.[META.paymentRequired]) return tool;
        const cost = price ? `${price.amount} of ${price.asset}` : "an unknown amount";
        return {
          ...tool,
          description: `${tool.description ?? ""} (This is a paid tool, you will be charged ${cost} for its execution)`
        };
      })
    };
  };

  const callTool = async (
    confirm: ConfirmationCallback | null,
    params: CallToolRequest["params"],
    options?: RequestOptions
  ): Promise<CallToolResult> => {
    const res = await invoke(params, options);
    const err = res._meta?.[META.error] as PaymentRequiredV2 | undefined;
    if (!res.isError || !err || !Array.isArray(err.accepts) || err.accepts.length === 0) {
      return res;
    }

    const expectedPrice = advertisedPrices.get(params.name);

    let payment: PaymentPayloadV2;
    try {
      payment = await payFor(
        err,
        cfg,
        confirm ?? cfg.confirmationCallback,
        expectedPrice
      );
    } catch (e) {
      // Nothing we can pay with: hand back the server's 402 untouched.
      if (e instanceof NoCompatibleRequirementError) return res;
      const text =
        e instanceof PaymentDeclinedError ||
        e instanceof PaymentCapError ||
        e instanceof AdvertisedPriceMismatchError
          ? e.message
          : "Failed to create payment payload";
      return { isError: true, content: [{ type: "text", text }] };
    }

    return invoke(
      { ...params, _meta: { ...params._meta, [META.payment]: encodePayment(payment) } },
      options
    );
  };

  for (const [key, value] of Object.entries({ listTools, callTool })) {
    Object.defineProperty(client, key, {
      value,
      writable: false,
      enumerable: false,
      configurable: true
    });
  }
  return client as unknown as Omit<T, "callTool"> & X402StacksAugmentedClient;
}

export type { StacksPaymentConfig, StacksPayerConfig };
