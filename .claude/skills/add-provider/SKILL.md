---
name: add-provider
description: Add a new free LLM provider (platform) to FreeLLMAPI end to end - adapter registration, Platform type, key parsing, dashboard entry, quota pool, docs and tests. Use when the user asks to add, integrate or support a new provider, API host or free tier.
argument-hint: <provider name or URL>
disable-model-invocation: true
---

# Add a provider

Adding provider: $ARGUMENTS

Reference commit: `git show a773d8e` (cheapllm.shop) touches every file a typical keyed
OpenAI-compatible provider needs. Read it before starting.

## 1. Verify facts first (do not skip)

From the provider's own documentation, collect and keep the source URL for each:

- Base URL, and whether it is OpenAI-compatible (`/v1/chat/completions`, `/v1/models`)
- Auth: keyed (header and format) or keyless
- Free-tier terms: rate limits, token/request quotas, per-key vs per-account
- Whether sign-up needs a credit card. **If it does, stop: the provider does not qualify.**
- Model ids offered for free

Never fill these in from memory. If a fact can't be verified, ask the user. Write the check date
(`YYYY-MM-DD`) next to every fact in comments and docs.

Pick a short lowercase platform id (e.g. `cheapllm`) and confirm it is unused:
`grep -rn "'<id>'" shared/types.ts server/src/providers/index.ts`.

## 2. Files to change

| File | Change |
| --- | --- |
| `shared/types.ts` | Add `\| '<id>'` to the `Platform` union with a comment (free terms, card policy, catalog source) |
| `server/src/providers/index.ts` | `register(new OpenAICompatProvider({ platform, name, baseUrl, timeoutMs? }))` with a sourced comment. Only write a dedicated adapter in `server/src/providers/<id>.ts` if the API is not OpenAI-compatible (see `base.ts`) |
| `server/src/lib/key-parser.ts` | `PREFIX_MAP` entry (`<ID>_`) and `AUTH_JSON_PROVIDER_MAP` aliases |
| `server/src/routes/keys.ts` | Add id to the `PLATFORMS` list |
| `server/src/services/provider-quota.ts` | `inferPoolForPlatform` if quota is per account; add to `isSharedPool` list if keys share a pool |
| `client/src/components/keys/shared.tsx` | `PLATFORMS` entry: `value`, `label`, sign-up `url`, `keyless` if applicable, dated comment |
| `client/src/lib/routing.ts` | `platformColors` entry |
| `docs/en/providers/01-supported-platforms.md` and `docs/zh-cn/...` | Table row with sourced free-tier notes; update the platform counts in the intro line |
| `server/src/db/migrations/` | Only if built-in model rows ship in the repo: **new** migration via `npm run db:migration:create --name=add_<id>_models`. Many providers are catalog-only and need none |
| `repo-assets/providers/<id>.png` | Logo, only if the user supplies one |

New UI strings go in `client/src/i18n/locales/en.json` first, then `/sync-i18n`.

## 3. Test

Create `server/src/__tests__/providers/<id>.test.ts` modelled on `cheapllm.test.ts`:
registration, base URL, any non-default timeout, `.env` prefix detection, auth.json aliases.
Add adapter-level tests for any custom response handling.

```bash
cd server && npx vitest run src/__tests__/providers/<id>.test.ts
cd .. && npm test && npm run lint && npm run build
```

## 4. Report

Tell the user the platform id, every file changed, and the source URL + date for each free-tier
fact. Flag anything you could not verify.
