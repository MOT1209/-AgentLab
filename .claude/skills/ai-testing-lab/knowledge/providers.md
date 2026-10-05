# LLM PROVIDERS

Code: src/providers/. Example config: providers.example.json.

Kinds:
- anthropic — official @anthropic-ai/sdk, API key. Optional `serverSideFallback` (beta, off by default, not yet exercised live).
- openai-compatible — POST {baseUrl}/chat/completions. Needs baseUrl (or a preset, see below).
- mock — tests and offline development.

Presets (src/providers/presets.ts): named shortcuts for common `openai-compatible` endpoints —
`openai`, `groq`, `openrouter`, `together`, `fireworks`, `ollama` (local, no key). Set
`"preset": "groq"` on a config instead of hand-writing `baseUrl`; `id`, `model` and `auth` are
still supplied by the caller as usual. An explicit `baseUrl` always wins over a preset's default.
"OpenCode/Zen" was raised by a user as a provider to add — its API/auth shape has not been
investigated yet; do not add it as a preset without confirming its integration shape first.

Rules:
- Config holds only the NAME of the env var (`auth.env`). A key in config is rejected and never echoed.
- A missing env var fails closed at startup.
- ProviderManager.forAgent(agentId, parentId): agent override → MAIN parent override → default.
- Handlers receive `ctx.llm` (undefined if no providers configured). Agents never see keys or URLs.
- describe() shows key presence, never the value. test(id) makes one tiny real request.

Not supported on purpose: linking a consumer subscription (Claude Pro/Max, ChatGPT Plus). Those do not include API access.
