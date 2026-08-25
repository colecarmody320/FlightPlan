import { CirrusProvider, CirrusProviderError } from "./types.ts";
import { createGeminiProvider } from "./gemini.ts";

/* ============================================================
   PROVIDER REGISTRY
   Selection is environment-driven so swapping providers is a config
   change, not a code change. Each entry owns reading its own
   credentials from the environment — nothing above this layer sees
   a key.
   ============================================================ */

const DEFAULT_PROVIDER = "gemini";
// Google retires older flash models for new users; 2.0 and 2.5 both
// return NOT_FOUND and its error names the current replacement. Override
// per-environment with CIRRUS_MODEL rather than editing this.
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

type ProviderFactory = () => CirrusProvider;

const FACTORIES: Record<string, ProviderFactory> = {
  gemini: () =>
    createGeminiProvider(
      Deno.env.get("GEMINI_API_KEY") ?? "",
      Deno.env.get("CIRRUS_MODEL") ?? DEFAULT_GEMINI_MODEL,
    ),
};

export function resolveProvider(): CirrusProvider {
  const name = (Deno.env.get("CIRRUS_PROVIDER") ?? DEFAULT_PROVIDER).toLowerCase();
  const factory = FACTORIES[name];

  if (!factory) {
    throw new CirrusProviderError(
      "server_misconfigured",
      `Unknown CIRRUS_PROVIDER "${name}"`,
      { status: 500 },
    );
  }

  return factory();
}
