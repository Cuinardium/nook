import { disableTool } from "eve/tools";

// deepseek-v4-flash via opencode-go (openai-compatible) does not support
// provider-defined search; without this the AI SDK warns every step about
// "gateway.exa_search is not supported" and clutters logs.
export default disableTool();
