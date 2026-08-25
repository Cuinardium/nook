import { z } from "zod";

const configSchema = z.object({
  openCodeBaseUrl: z.url().default("https://opencode.ai/zen/go/v1"),
  openCodeApiKey: z.string().min(1),
  openCodeModel: z.string().default("deepseek-v4-flash"),
  modelContextTokens: z.coerce.number().int().positive().default(131072),
  timezone: z.string().default("America/Argentina/Buenos_Aires"),
  commitEmail: z.email(),
});

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

/**
 * Validated app configuration. Lazy on purpose: `eve build` evaluates
 * authored modules without production env, so nothing may touch the env at
 * module top level. First call validates and caches; missing required
 * values throw here with a clear error.
 */
export function getConfig(): Config {
  cached ??= configSchema.parse({
    openCodeBaseUrl: process.env.OPENCODE_BASE_URL,
    openCodeApiKey: process.env.OPENCODE_API_KEY,
    openCodeModel: process.env.OPENCODE_MODEL,
    modelContextTokens: process.env.NOOK_MODEL_CONTEXT_TOKENS,
    timezone: process.env.NOOK_TIMEZONE,
    commitEmail: process.env.NOOK_COMMIT_EMAIL,
  });
  return cached;
}
