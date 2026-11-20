# muse-claude-pilot
Disposable Muse + Claude Code pilot (Nov 20–27, 2026). No private data, proprietary code, or secrets.

## Dev
Zero dependencies. Node 20+.

```
npm test
```

CI (`.github/workflows/test.yml`) runs `npm test` on every PR and on pushes to `main`.

## Helpers
- `src/truncate.js`: `truncateWords(text, maxWords)` truncates text to a word limit, appending "…".
- `src/wordcount.js`: `wordCount(text)` counts whitespace-separated words.
- `src/capitalize.js`: `capitalize(text)` uppercases the first character.
