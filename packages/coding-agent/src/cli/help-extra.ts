import chalk from "@oh-my-pi/pi-utils/chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";
import { tSettingsUi } from "../i18n/settings-locale";

export function getExtraHelpText(): string {
	return `${chalk.bold(tSettingsUi("Environment Variables:"))}
  ${chalk.dim(`# ${tSettingsUi("Core Providers")}`)}
  ANTHROPIC_API_KEY          - ${tSettingsUi("Anthropic Claude models")}
  ANTHROPIC_OAUTH_TOKEN      - ${tSettingsUi("Anthropic OAuth (takes precedence over API key)")}
  CLAUDE_CODE_USE_FOUNDRY    - ${tSettingsUi("Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)")}
  FOUNDRY_BASE_URL           - ${tSettingsUi("Anthropic Foundry base URL (e.g., https://<foundry-host>)")}
  ANTHROPIC_FOUNDRY_API_KEY  - ${tSettingsUi("Anthropic token used as Authorization: Bearer <token> in Foundry mode")}
  ANTHROPIC_CUSTOM_HEADERS   - ${tSettingsUi('Extra headers for Foundry or any custom ANTHROPIC_BASE_URL gateway (e.g., "user-id: USERNAME")')}
  CLAUDE_CODE_CLIENT_CERT    - ${tSettingsUi("Client certificate (PEM path or inline PEM) for mTLS")}
  CLAUDE_CODE_CLIENT_KEY     - ${tSettingsUi("Client private key (PEM path or inline PEM) for mTLS")}
  NODE_EXTRA_CA_CERTS        - ${tSettingsUi("CA bundle path (or inline PEM) for server certificate validation")}
  OPENAI_API_KEY             - ${tSettingsUi("OpenAI GPT models")}
  GEMINI_API_KEY             - ${tSettingsUi("Google Gemini models")}
  COPILOT_GITHUB_TOKEN      - ${tSettingsUi("GitHub Copilot")}

  ${chalk.dim(`# ${tSettingsUi("Additional LLM Providers")}`)}
  AZURE_OPENAI_API_KEY       - ${tSettingsUi("Azure OpenAI models")}
  GROQ_API_KEY               - ${tSettingsUi("Groq models")}
  CEREBRAS_API_KEY           - ${tSettingsUi("Cerebras models")}
  XAI_API_KEY                - ${tSettingsUi("xAI Grok models")}
  OPENROUTER_API_KEY         - ${tSettingsUi("OpenRouter aggregated models")}
  KILO_API_KEY               - ${tSettingsUi("Kilo Gateway models")}
  MISTRAL_API_KEY            - ${tSettingsUi("Mistral models")}
  ZAI_API_KEY                - ${tSettingsUi("z.ai models (ZhipuAI/GLM)")}
  UMANS_AI_CODING_PLAN_API_KEY - ${tSettingsUi("Umans AI Coding Plan models")}
  UMANS_WEBSEARCH_PROVIDER    - ${tSettingsUi("Umans gateway web search backend (native or exa)")}
  MINIMAX_API_KEY            - ${tSettingsUi("MiniMax models")}
  OPENCODE_API_KEY           - ${tSettingsUi("OpenCode Zen/OpenCode Go models")}
  CURSOR_ACCESS_TOKEN        - ${tSettingsUi("Cursor AI models")}
  AI_GATEWAY_API_KEY         - ${tSettingsUi("Vercel AI Gateway")}
  WAFER_SERVERLESS_API_KEY   - ${tSettingsUi("Wafer Serverless (pay-as-you-go)")}

  ${chalk.dim(`# ${tSettingsUi("Cloud Providers")}`)}
  AWS_PROFILE                - ${tSettingsUi("AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)")}
  GOOGLE_CLOUD_PROJECT       - ${tSettingsUi("Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)")}
  GOOGLE_APPLICATION_CREDENTIALS - ${tSettingsUi("Service account for Vertex AI")}

  ${chalk.dim(`# ${tSettingsUi("Search & Tools")}`)}
  EXA_API_KEY                - ${tSettingsUi("Exa web search")}
  BRAVE_API_KEY              - ${tSettingsUi("Brave web search")}
  PERPLEXITY_API_KEY         - ${tSettingsUi("Perplexity web search API key (optional; anonymous fallback)")}
  PERPLEXITY_COOKIES         - ${tSettingsUi("Perplexity web search (session cookie)")}
  TAVILY_API_KEY             - ${tSettingsUi("Tavily web search")}
  TINYFISH_API_KEY           - ${tSettingsUi("TinyFish web search")}
  FIRECRAWL_API_KEY          - ${tSettingsUi("Firecrawl web search")}
  ANTHROPIC_SEARCH_API_KEY   - ${tSettingsUi("Anthropic web search (override; isolates search from main ANTHROPIC_API_KEY)")}
  ANTHROPIC_SEARCH_BASE_URL  - ${tSettingsUi("Anthropic web search base URL (override; pairs with ANTHROPIC_SEARCH_API_KEY)")}

  ${chalk.dim(`# ${tSettingsUi("Configuration")}`)}
  OMP_PROFILE                 - ${tSettingsUi("Named profile for isolated agent state (same as --profile)")}
  ${tSettingsUi("Use `{command}` to create a shell shortcut for a profile", { command: `omp --profile <name> --alias <command>` })}
  PI_CODING_AGENT_DIR        - ${tSettingsUi("Session storage directory (default: ~/{configDir}/agent)", { configDir: CONFIG_DIR_NAME })}
  PI_PACKAGE_DIR             - ${tSettingsUi("Override package directory (for Nix/Guix store paths)")}
  PI_SMOL_MODEL              - ${tSettingsUi("Override smol/fast model (see --smol)")}
  PI_SLOW_MODEL              - ${tSettingsUi("Override slow/reasoning model (see --slow)")}
  PI_PLAN_MODEL              - ${tSettingsUi("Override planning model (see --plan)")}
  PI_NO_PTY                  - ${tSettingsUi("Disable PTY-based interactive bash execution")}
  ${tSettingsUi("For complete environment variable reference, see:")}
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold(tSettingsUi("Available Tools (default-enabled unless noted):"))}
  read          - ${tSettingsUi("Read file contents")}
  bash          - ${tSettingsUi("Execute bash commands")}
  edit          - ${tSettingsUi("Edit files with find/replace")}
  write         - ${tSettingsUi("Write files (creates/overwrites)")}
  grep          - ${tSettingsUi("Search file contents")}
  find          - ${tSettingsUi("Find files by glob pattern")}
  multi_grep    - ${tSettingsUi("Search file contents")}
  lsp           - ${tSettingsUi("Language server protocol (code intelligence)")}
  python        - ${tSettingsUi("Execute Python code (requires: {command})", { command: `${APP_NAME} setup python` })}
  notebook      - ${tSettingsUi("Edit Jupyter notebooks")}
  inspect_image - ${tSettingsUi("Analyze images with a vision model")}
  browser       - ${tSettingsUi("Browser automation (Puppeteer)")}
  computer      - ${tSettingsUi("Native host desktop capture and input (disabled by default)")}
  task          - ${tSettingsUi("Launch sub-agents for parallel tasks")}
  todo          - ${tSettingsUi("Manage todo/task lists")}
  web_search    - ${tSettingsUi("Search the web")}
  ask           - ${tSettingsUi("Ask user questions (interactive mode only)")}

${chalk.bold(tSettingsUi("Plugin Options:"))}
  --plugin-dir <path>        ${tSettingsUi("Load plugin from directory (repeatable)")}

${chalk.bold(tSettingsUi("Useful Commands:"))}
  omp agents unpack           - ${tSettingsUi("Export bundled subagents to ~/.omp/agent/agents (default)")}
  omp agents unpack --project - ${tSettingsUi("Export bundled subagents to ./.omp/agents")}`;
}
