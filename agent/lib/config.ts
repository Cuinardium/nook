import { z } from "zod";

/**
 * Global configuration, parsed eagerly from the environment at startup.
 * A malformed or missing value crashes the process at boot with an
 * actionable error instead of failing later at runtime.
 */
const configSchema = z.object({
  openCodeBaseUrl: z.url().default("https://opencode.ai/zen/go/v1"),
  openCodeApiKey: z.string().min(1, "OPENCODE_API_KEY is required"),
  openCodeModel: z.string().default("deepseek-v4-flash"),
  modelContextTokens: z.coerce.number().int().positive().default(131072),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
  commitEmail: z.email(),
});

export const config = configSchema.parse({
  openCodeBaseUrl: process.env.OPENCODE_BASE_URL,
  openCodeApiKey: process.env.OPENCODE_API_KEY,
  openCodeModel: process.env.OPENCODE_MODEL,
  modelContextTokens: process.env.NOOK_MODEL_CONTEXT_TOKENS,
  timezone: process.env.NOOK_TIMEZONE,
  commitEmail: process.env.NOOK_COMMIT_EMAIL,
});
