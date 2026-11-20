---
name: sync-i18n
description: Add, rename or remove dashboard translation keys across all 60 locale files so they stay in parity with en.json, then run the i18n validator. Use after adding UI strings to client/src/i18n/locales/en.json, or when check:i18n fails.
argument-hint: [key path(s), e.g. keys.dialog.testButton]
---

# Sync dashboard translations

Locales live in `client/src/i18n/locales/*.json` (60 files). `en.json` is the source of truth.
Rules are in `docs/TRANSLATION.md`; read its terminology tables before translating zh-CN.

Keys to sync: $ARGUMENTS (if empty, find them by running the validator).

## Steps

1. **Find the gap.**
   ```bash
   cd client && npm run check:i18n
   ```
   It reports missing/extra keys, wrong value types and mismatched `{placeholder}` names per locale.

2. **Change `en.json` first.** Never add or remove a key in another locale on its own.

3. **Apply to every other locale with a script, not 59 hand edits.** Write a short Node script in
   the scratchpad (not the repo) that, for each locale file:
   - inserts the new key at the same position as in `en.json` (preserve key order),
   - deletes removed keys, moves renamed keys keeping the existing translation,
   - keeps 2-space indentation and a trailing newline, matching the existing files.

4. **Translate the new values** per locale. Translate meaning, not words. Keep every
   `{placeholder}` exactly as in English. Keep brand and product names untranslated.
   If you can't produce a reliable translation for a language, use the English text and list
   that locale in your report rather than guessing.

5. **Validate.**
   ```bash
   cd client && npm run check:i18n && npx vitest run
   ```

6. **Report** which keys changed, and any locales left with English fallback text.

Only touch `docs/<lang>/` pages if the user asked for docs translation; that is a separate job.
