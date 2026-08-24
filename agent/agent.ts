import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const opencode = createOpenAICompatible({
  name: "opencode-go",
  baseURL: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  apiKey: process.env.OPENCODE_API_KEY ?? "",
});

export default defineAgent({
  model: opencode(process.env.OPENCODE_MODEL ?? "deepseek-v4-flash"),
  compaction: {
    thresholdPercent: 0.75,
  },
});
