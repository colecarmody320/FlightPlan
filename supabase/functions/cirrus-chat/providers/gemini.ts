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
  error?: { message?: string; status?: string };
}

export function createGeminiProvider(apiKey: string, model: string): CirrusProvider {
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
      // Gemini calls the assistant role "model".
      const contents = [
        ...req.history.map((m) => ({
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
        // Read the provider's own message for diagnostics, but never
        // echo raw provider payloads back to the client.
        let detail = "";
        try {
          const errBody = (await res.json()) as GeminiResponse;
          detail = errBody?.error?.status || errBody?.error?.message || "";
        } catch {
          /* body wasn't JSON — status alone is enough */
        }

        if (res.status === 429) {
          throw new CirrusProviderError(
            "provider_rate_limited",
            "Gemini rate limit or quota exceeded",
            { status: 429, retryable: true },
          );
        }
        if (res.status === 401 || res.status === 403) {
          // A bad/expired key is a server misconfiguration, not a user error.
          throw new CirrusProviderError(
            "server_misconfigured",
            "Gemini rejected the configured credentials",
            { status: 500, retryable: false },
          );
        }
        if (res.status >= 500) {
          throw new CirrusProviderError(
            "provider_error",
            `Gemini returned ${res.status}`,
            { status: 502, retryable: true },
          );
        }
        throw new CirrusProviderError(
          "provider_error",
          `Gemini returned ${res.status}${detail ? ` (${detail})` : ""}`,
          { status: 502, retryable: false },
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
        throw new CirrusProviderError(
          "malformed_provider_response",
          "Gemini returned no usable text",
          { status: 502 },
        );
      }

      return { reply, model, finishReason: candidate?.finishReason };
    },
  };
}
