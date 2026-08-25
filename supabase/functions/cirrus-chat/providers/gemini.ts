import {
  CirrusProvider,
  CirrusProviderError,
  CirrusProviderRequest,
  CirrusProviderResult,
} from "./types.ts";

/* ============================================================
   GEMINI PROVIDER
   The API key is read from the environment by the caller and held
   only in this closure. It is never logged, never included in an
   error message, and never returned to the client.
   ============================================================ */

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: {
    message?: string;
    status?: string;
    details?: Array<{ reason?: string }>;
  };
}

export function createGeminiProvider(rawApiKey: string, model: string): CirrusProvider {
  // Secrets pasted through a dashboard commonly pick up a trailing
  // newline or space. Google rejects those as API_KEY_INVALID, which
  // surfaces as an opaque 400, so normalize before use.
  const apiKey = (rawApiKey || "").trim();

  if (!apiKey) {
    throw new CirrusProviderError(
      "server_misconfigured",
      "GEMINI_API_KEY is not set",
      { status: 500 },
    );
  }

  return {
    name: "gemini",
    model,

    async generate(req: CirrusProviderRequest): Promise<CirrusProviderResult> {
      // Gemini requires the first turn to be "user" and rejects a
      // conversation that opens on a model turn. Trimming history to the
      // most recent N can leave a leading assistant turn, so drop those.
      const history = [...req.history];
      while (history.length && history[0].role === "assistant") history.shift();

      // Gemini calls the assistant role "model".
      const contents = [
        ...history.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        { role: "user", parts: [{ text: req.message }] },
      ];

      const body = {
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents,
        generationConfig: {
          maxOutputTokens: req.maxOutputTokens,
          temperature: 0.7,
        },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs);

      let res: Response;
      try {
        res = await fetch(
          `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            // Key travels in a header, not the URL, so it cannot leak
            // through redirect or error-URL logging.
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        throw new CirrusProviderError(
          aborted ? "provider_timeout" : "network_error",
          aborted
            ? `Gemini did not respond within ${req.timeoutMs}ms`
            : "Could not reach the Gemini API",
          { status: aborted ? 504 : 502, retryable: true },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // Google's status ("INVALID_ARGUMENT") is broad; the useful part
        // is `details[].reason` ("API_KEY_INVALID"). Both are structural
        // metadata, never credentials or conversation content.
        let gStatus = "";
        let gReason = "";
        let gMessage = "";
        try {
          const errBody = (await res.json()) as GeminiResponse;
          gStatus = errBody?.error?.status || "";
          gReason =
            (errBody?.error?.details || [])
              .map((d) => d?.reason)
              .find((r): r is string => Boolean(r)) || "";
          // error.message is the only field that says *what* was wrong
          // with a rejected payload ("Unknown name X: Cannot find
          // field"). Google names the offending field, not its value.
          gMessage = (errBody?.error?.message || "").slice(0, 300);
        } catch {
          /* body wasn't JSON — status alone is enough */
        }
        const label = [gStatus, gReason, gMessage].filter(Boolean).join(": ");
        const meta = { providerStatus: res.status, providerReason: gReason || gStatus };

        // Shape of what we sent, so a rejected payload can be compared
        // against the schema. Counts and field names only — no prompt
        // text, no message text, no credentials.
        console.log(
          JSON.stringify({
            event: "gemini_request_shape",
            model,
            bodyKeys: Object.keys(body),
            contentsCount: contents.length,
            firstRole: contents[0]?.role,
            roles: contents.map((c) => c.role),
            hasSystemInstruction: Boolean(req.systemPrompt),
            systemPromptChars: req.systemPrompt.length,
            messageChars: req.message.length,
            generationConfig: body.generationConfig,
          }),
        );

        if (res.status === 429) {
          throw new CirrusProviderError(
            "provider_rate_limited",
            "Gemini rate limit or quota exceeded",
            { status: 429, retryable: true, ...meta },
          );
        }
        // A rejected key arrives as 401/403, or as a 400 carrying
        // API_KEY_INVALID. All three are configuration problems, not
        // provider outages, and must not be retried.
        const badKey =
          res.status === 401 ||
          res.status === 403 ||
          gReason === "API_KEY_INVALID" ||
          gReason === "API_KEY_SERVICE_BLOCKED";
        if (badKey) {
          throw new CirrusProviderError(
            "server_misconfigured",
            `Gemini rejected the configured credentials (${label || res.status})`,
            { status: 500, retryable: false, ...meta },
          );
        }
        if (res.status >= 500) {
          throw new CirrusProviderError(
            "provider_error",
            `Gemini returned ${res.status}`,
            { status: 502, retryable: true, ...meta },
          );
        }
        throw new CirrusProviderError(
          "provider_error",
          `Gemini returned ${res.status}${label ? ` (${label})` : ""}`,
          { status: 502, retryable: false, ...meta },
        );
      }

      let parsed: GeminiResponse;
      try {
        parsed = (await res.json()) as GeminiResponse;
      } catch {
        throw new CirrusProviderError(
          "malformed_provider_response",
          "Gemini returned a body that was not valid JSON",
          { status: 502 },
        );
      }

      if (parsed.promptFeedback?.blockReason) {
        throw new CirrusProviderError(
          "provider_blocked",
          `Gemini declined to answer (${parsed.promptFeedback.blockReason})`,
          { status: 422, retryable: false },
        );
      }

      const candidate = parsed.candidates?.[0];
      const reply = (candidate?.content?.parts || [])
        .map((p) => p.text || "")
        .join("")
        .trim();

      if (!reply) {
        // finishReason explains the common empty-reply causes (MAX_TOKENS
        // on a thinking model, SAFETY, RECITATION) that would otherwise
        // be indistinguishable.
        throw new CirrusProviderError(
          "malformed_provider_response",
          `Gemini returned no usable text${
            candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : ""
          }`,
          { status: 502 },
        );
      }

      return { reply, model, finishReason: candidate?.finishReason };
    },
  };
}
