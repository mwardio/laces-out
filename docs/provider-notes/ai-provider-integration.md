# AI provider and chat-product integration

Verified: 2026-07-30
Scope: OpenAI, Anthropic, Google Gemini, DeepSeek, Grok, and OpenRouter
Decision status: managed Gemini plus per-user BYOK implemented; chat-product MCP connectors remain future work

## Product boundary

Keep these concepts separate:

1. **Sign in to Laces Out** authenticates a member to this application.
2. **Use the Film room** calls managed Gemini by default or a separately billed model API when the
   member has added a personal key.
3. **Connect Laces Out to a chat product** would expose scoped fantasy tools through remote MCP.
   This is not implemented and is independent of BYOK.

Do not label API-key setup “Sign in with ChatGPT,” “Sign in with Claude,” or equivalent. Consumer
chat subscriptions are not transferable model API credentials.

## Managed default

When `GEMINI_API_KEY` is present in the API server environment, every signed-in member can use Film
Room without provider setup. Managed requests always use `gemini-3.6-flash`; clients cannot
override that model. The default allowance is 50 requests per member per UTC day with a 2,000-token
answer ceiling. Both limits are operator-configurable. A saved member key takes precedence for its
provider, and removing a member Gemini key restores managed Gemini.

The operator key is never sent to browser code or persisted in PostgreSQL. Managed usage rows have
no credential ID and are counted separately from that member's BYOK usage. Google's free-tier terms
state that submitted content may be used to improve its products; the public privacy notice
discloses that processing.

## Implemented BYOK provider contracts

| Provider      | Native endpoint                 | Authentication               | Default model        |
| ------------- | ------------------------------- | ---------------------------- | -------------------- |
| OpenAI        | `POST /v1/responses`            | Bearer API key               | `gpt-5.6-luna`       |
| Anthropic     | `POST /v1/messages`             | `x-api-key` plus API version | `claude-sonnet-5`    |
| Google Gemini | `POST /v1/interactions`         | `x-goog-api-key`             | `gemini-3.6-flash`   |
| DeepSeek      | `POST /chat/completions`        | Bearer API key               | `deepseek-v4-flash`  |
| Grok (xAI)    | `POST /v1/chat/completions`     | Bearer API key               | `grok-4.3`           |
| OpenRouter    | `POST /api/v1/chat/completions` | Bearer API key               | `~openai/gpt-latest` |

The model field is editable only after a member supplies a key because provider catalogs change
faster than this application. Laces Out uses the six native protocols rather than relying on a
lowest-common-denominator client. It does not set custom sampling parameters, invoke provider
tools outside the bounded Gemini start/sit path, or enable background execution.
OpenAI Responses and Gemini Interactions explicitly use stateless storage settings. OpenRouter
requests include the deployment origin and Laces Out title for provider attribution.

Official sources:

- <https://developers.openai.com/api/docs/guides/latest-model>
- <https://developers.openai.com/api/reference/resources/responses/methods/create>
- <https://platform.claude.com/docs/en/manage-claude/authentication>
- <https://platform.claude.com/docs/en/api/messages/create>
- <https://ai.google.dev/gemini-api/docs/interactions-overview>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash>
- <https://ai.google.dev/gemini-api/docs/pricing>
- <https://ai.google.dev/gemini-api/docs/api-key>
- <https://ai.google.dev/api/interactions-api-v1>
- <https://openrouter.ai/docs/quickstart>
- <https://openrouter.ai/docs/api/reference/authentication>
- <https://api-docs.deepseek.com/api/create-chat-completion>
- <https://api-docs.deepseek.com/api/list-models>
- <https://docs.x.ai/developers/rest-api-reference/inference/chat>
- <https://docs.x.ai/developers/models>

## Credential and privacy design

- The operator Gemini key is read only from the API server environment and never returned or stored
  in the database.
- BYOK configuration endpoints are authenticated and same-origin protected.
- A key enters only a write request and is explicitly redacted from structured request logging.
- Keys are encrypted with AES-256-GCM and authenticated purpose
  `ai-key:<user-id>:<provider>`; the encryption key remains outside PostgreSQL.
- The API never returns the key, a key suffix, the encrypted envelope, or its fingerprint.
- Replacing a key creates a new envelope and resets validation state. Removing a provider deletes
  the encrypted key; historical usage rows retain no credential material.
- Credential fingerprints, OpenAI safety identifiers, and provider request identifiers use
  domain-separated keyed hashes.
- Raw questions and model answers are not stored, with one scoped exception: a Weekly Reckoning
  recap is persisted as league data in `weekly_recaps`, one row per league season and week, and is
  replaced on reroll. A failed generation stores nothing. The usage ledger retains provider, model,
  operation, token counts, cache counts, latency, success/error code, time, and league ID.

## Grounded analysis

The Film room reuses the same authorization-scoped services as the signed-in app. Before a model
call it loads:

- **League overview:** membership, provider freshness, teams, standings, matchup, and claimed team;
- **Decision Desk:** deterministic lineup, waiver, and trade output plus projection provenance;
- **League analytics:** score history, power, positional strengths/weaknesses, and opponent scout.

Context is depth-, string-, and array-bounded before serialization. The prompt labels synced names
and fields as untrusted data, makes deterministic recommendations the ranking source of truth,
requires visible Laces Out source tags, forbids invented current news, and states that Yahoo/ESPN
actions remain manual. The model receives neither the API key nor tools, SQL, arbitrary retrieval,
another member's private data, or provider-write authority.

## Cost and failure controls

- Managed Gemini defaults to an operator-controlled 50 requests per member per UTC day and a
  2,000-token answer ceiling. The model is fixed server-side.
- Every BYOK provider has a user-editable 1–500 request limit per UTC day and a 64–8192
  answer-token ceiling. Defaults are 25 requests and 2,000 answer tokens.
- Connection tests are real, small provider requests and count against the daily limit.
- Analysis and test routes have additional per-minute limits; provider calls time out after 30
  seconds.
- Authentication rejection marks the key invalid. Quota, model, network, and transient errors are
  recorded without silently invalidating an otherwise usable key.
- Provider response bodies are not copied into application errors or logs. Accurate cost remains
  visible in the member's provider account; Laces Out does not guess from fast-changing price tables.

## Future chat-product connector

An OAuth 2.1/PKCE-protected remote MCP service could later let ChatGPT, Claude, or another compatible
client call read-only Laces Out tools. That design would authenticate the user to Laces Out and
recheck league membership for each tool; it would not transfer a consumer subscription into this
web app. Candidate tools include weekly dashboard, opponent scout, lineup optimization, waiver
ranking, trade analysis, and draft-board reads. Provider writes require a separate scope, preview,
confirmation, receipt, and reconciliation and are not part of the initial MCP surface.
