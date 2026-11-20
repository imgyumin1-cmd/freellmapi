# FreeLLMAPI

Local-first aggregator for free LLM API tiers. One OpenAI-compatible endpoint
(`http://127.0.0.1:3001/v1`) routes requests across many free providers with
fallback, rate-limit tracking and encrypted key storage. A React dashboard manages
keys, models and routing.

## Layout

npm workspaces monorepo (Node `>=20.18 <25`, see `.nvmrc`).

| Path | What it is |
| --- | --- |
| `server/` | Express 5 + better-sqlite3 API and router. `src/providers/` adapters, `src/routes/`, `src/services/`, `src/lib/`, `src/db/migrations/` |
| `client/` | React 19 + Vite + Tailwind 4 dashboard. 60 locales in `src/i18n/locales/` |
| `cli/` | `freellmapi` CLI (doctor, keys, models, agent config) |
| `shared/` | Types shared by server and client (`types.ts` holds the `Platform` union) |
| `desktop/` | Electron app. Separate `package.json`, not a workspace |
| `docs/` | `docs/en/` and `docs/zh-cn/` mirror each other page by page |

## Commands

```bash
npm run dev                 # server :3001 + dashboard :5173
npm test                    # all suites (server vitest, cli, client, hook tests)
npm run test -w server      # server only
npx vitest run <file>       # one test file (run inside server/ or client/)
npm run lint                # server + cli (client is not lint-clean yet; don't "fix" it wholesale)
npm run build               # tsc + vite build
npm run test:migrations     # migration up/down round trip
cd client && npm run check:i18n   # locale key parity
```

## Rules

- Every change ships with a test and keeps `npm test` green.
- Keep diffs scoped. Don't reformat, rename or rewrite comments in files you aren't changing.
- **Migrations:** never edit an existing file in `server/src/db/migrations/`. Add a new one
  with `npm run db:migration:create --name=<snake_case>`. Built-in catalog rows change through
  new forward migrations too.
- **i18n:** keys start in `client/src/i18n/locales/en.json`; every other locale mirrors them.
  Never add or remove a key in one locale alone. zh-CN terminology is fixed in `docs/TRANSLATION.md`.
- **No invented facts:** provider rate limits, model ids, endpoints and free-tier terms must be
  checked against the provider's own docs and cited with a date (see existing comments in
  `server/src/providers/index.ts`). Never recall them from memory.
- Only genuinely free providers that need no credit card belong in the catalog.
- Never log or return raw API keys. Use `server/src/lib/log-redaction.ts` and `lib/crypto.ts`.
- Don't hand-edit `package-lock.json` or `.env`; use npm and `.env.example`.

## Adding a provider

Use the `/add-provider` skill. It lists every file a provider touches.

## Claude Code setup in this repo

- `.claude/settings.json` wires two hooks: `contributing-check.mjs` (reminds of CONTRIBUTING.md
  rules before `git commit`/`git push`) and `protect-files.mjs` (blocks edits to applied
  migrations, `package-lock.json`, `.env`).
- Skills: `/add-provider`, `/sync-i18n`. Subagent: `security-reviewer`.
- `.mcp.json` adds the context7 docs server.
