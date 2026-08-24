import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent, defineDynamic } from "eve";

const opencode = createOpenAICompatible({
  name: "opencode-go",
  baseURL: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  apiKey: process.env.OPENCODE_API_KEY ?? "",
});

// OpenCode Go models are not in the AI Gateway catalog, so the context window
// must be stated explicitly for compaction. Override via env if it changes.
const CONTEXT_TOKENS = Number(process.env.NOOK_MODEL_CONTEXT_TOKENS ?? 131072);

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => ({
        model: opencode(process.env.OPENCODE_MODEL ?? "deepseek-v4-flash"),
        modelContextWindowTokens: CONTEXT_TOKENS,
      }),
    },
  }),
  compaction: {
    thresholdPercent: 0.75,
    modelContextWindowTokens: CONTEXT_TOKENS,
  },
});
