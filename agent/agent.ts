import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent, defineDynamic } from "eve";
import { config } from "./lib/config";

const opencode = createOpenAICompatible({
  name: "opencode-go",
  baseURL: config.openCodeBaseUrl,
  apiKey: config.openCodeApiKey,
});

// OpenCode Go models are not in the AI Gateway catalog, so the context window
// must be stated explicitly for compaction.
const CONTEXT_TOKENS = config.modelContextTokens;

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => ({
        model: opencode(config.openCodeModel),
        modelContextWindowTokens: CONTEXT_TOKENS,
      }),
    },
  }),
  compaction: {
    thresholdPercent: 0.75,
    modelContextWindowTokens: CONTEXT_TOKENS,
  },
});
