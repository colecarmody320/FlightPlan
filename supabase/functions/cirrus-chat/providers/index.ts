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
// gemini-2.0-flash 404s against this project's key; 2.5-flash resolves.
// Override per-environment with CIRRUS_MODEL.
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

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
