import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent, defineDynamic } from "eve";
import { getConfig } from "./lib/config";

// OpenCode Go models are not in the AI Gateway catalog, so the context window
// must be stated explicitly for compaction. Definition-level read: tolerates
// absence, and `|| fallback` also absorbs NaN from garbage values.
const CONTEXT_TOKENS = Number(process.env.NOOK_MODEL_CONTEXT_TOKENS) || 131072;

// Built lazily on the first step: authored modules are evaluated at build
// time without production env, and the API key is required.
// One model per eve session so every OpenCode Go request carries a stable
// per-conversation `x-opencode-session` header (required from 09/06).
type OpenCodeModel = ReturnType<ReturnType<typeof createOpenAICompatible>>;
const models = new Map<string, OpenCodeModel>();
function opencodeModel(sessionId: string) {
  const cached = models.get(sessionId);
  if (cached) {
    return cached;
  }
  const { openCodeBaseUrl, openCodeApiKey, openCodeModel } = getConfig();
  const model = createOpenAICompatible({
    name: "opencode-go",
    baseURL: openCodeBaseUrl,
    apiKey: openCodeApiKey,
    headers: { "x-opencode-session": sessionId },
  })(openCodeModel);
  models.set(sessionId, model);
  return model;
}

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => ({
        model: opencodeModel(ctx.session.id),
        modelContextWindowTokens: CONTEXT_TOKENS,
      }),
    },
  }),
  compaction: {
    thresholdPercent: 0.75,
    modelContextWindowTokens: CONTEXT_TOKENS,
  },
});
