/* ============================================================
   CIRRUS — AI provider abstraction
   Gemini is the initial provider, but nothing above this boundary
   knows that. To add a provider, implement CirrusProvider and
   register it in ./index.ts — no other file should need to change.
   ============================================================ */

export interface CirrusProviderRequest {
  /** Composed system prompt (personality + mode + task + context). */
  systemPrompt: string;
  /** Prior turns, oldest first, already trimmed and capped by the caller. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** The new user message. */
  message: string;
  /** Hard ceiling on generated length. */
  maxOutputTokens: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
}

export interface CirrusProviderResult {
  reply: string;
  model: string;
  /** Provider-reported stop reason, when it gives one. Diagnostic only. */
  finishReason?: string;
}

/**
 * Error codes are part of the contract with the frontend: the client
 * switches on `code`, never on message text. Keep these stable.
 */
export type CirrusErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "rate_limited"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_blocked"
  | "provider_error"
  | "malformed_provider_response"
  | "server_misconfigured"
  | "network_error"
  | "unknown";

export class CirrusProviderError extends Error {
  code: CirrusErrorCode;
  /** HTTP status to surface to the client. */
  status: number;
  /** True when a retry could plausibly succeed. */
  retryable: boolean;
  /** Provider's own HTTP status, for logs. Never contains credentials. */
  providerStatus?: number;
  /** Provider's machine-readable reason, e.g. "API_KEY_INVALID". */
  providerReason?: string;

  constructor(
    code: CirrusErrorCode,
    message: string,
    opts: {
      status?: number;
      retryable?: boolean;
      providerStatus?: number;
      providerReason?: string;
    } = {},
  ) {
    super(message);
    this.name = "CirrusProviderError";
    this.code = code;
    this.status = opts.status ?? 502;
    this.retryable = opts.retryable ?? false;
    this.providerStatus = opts.providerStatus;
    this.providerReason = opts.providerReason;
  }
}

export interface CirrusProvider {
  readonly name: string;
  /** Resolved model id, for diagnostics. Never includes credentials. */
  readonly model: string;
  generate(req: CirrusProviderRequest): Promise<CirrusProviderResult>;
}
