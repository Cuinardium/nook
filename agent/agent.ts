import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent, defineDynamic } from "eve";
import { getConfig } from "./lib/config";

// OpenCode Go models are not in the AI Gateway catalog, so the context window
// must be stated explicitly for compaction. Definition-level read: tolerates
// absence, and `|| fallback` also absorbs NaN from garbage values.
const CONTEXT_TOKENS = Number(process.env.NOOK_MODEL_CONTEXT_TOKENS) || 131072;

// Built lazily on the first step: authored modules are evaluated at build
// time without production env, and the API key is required.
let factory: ReturnType<typeof createOpenAICompatible> | undefined;
function opencodeModel() {
  const { openCodeBaseUrl, openCodeApiKey, openCodeModel } = getConfig();
  factory ??= createOpenAICompatible({
    name: "opencode-go",
    baseURL: openCodeBaseUrl,
    apiKey: openCodeApiKey,
  });
  return factory(openCodeModel);
}

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => ({
        model: opencodeModel(),
        modelContextWindowTokens: CONTEXT_TOKENS,
      }),
    },
  }),
  compaction: {
    thresholdPercent: 0.75,
    modelContextWindowTokens: CONTEXT_TOKENS,
  },
});
