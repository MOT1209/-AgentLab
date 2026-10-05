# LLM PROVIDERS

Code: src/providers/. Example config: providers.example.json.

Kinds:
- anthropic — official @anthropic-ai/sdk, API key. Optional `serverSideFallback` (beta, off by default, not yet exercised live).
- openai-compatible — POST {baseUrl}/chat/completions. OpenAI, OpenRouter, Ollama, LM Studio, vLLM. Needs baseUrl.
- mock — tests and offline development.

Rules:
- Config holds only the NAME of the env var (`auth.env`). A key in config is rejected and never echoed.
- A missing env var fails closed at startup.
- ProviderManager.forAgent(agentId, parentId): agent override → MAIN parent override → default.
- Handlers receive `ctx.llm` (undefined if no providers configured). Agents never see keys or URLs.
- describe() shows key presence, never the value. test(id) makes one tiny real request.

Not supported on purpose: linking a consumer subscription (Claude Pro/Max, ChatGPT Plus). Those do not include API access.
