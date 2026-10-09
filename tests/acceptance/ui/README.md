# Compact panel rendered check

Run from repository root with an existing Playwright installation and browser:

```powershell
$env:PLAYWRIGHT_MODULE = '<absolute path to playwright/index.mjs>'
$env:CHROME_EXECUTABLE = '<absolute path to chrome.exe>'
node tests/acceptance/ui/compact-panel.mjs
```

The harness uses the actual view/controller/CSS with a controlled transport and disposable browser profile. It saves geometry and screenshots to `.local/sprint9/`. It tests 259×499 containment, 20 messages, single transcript scrolling, composer sizes, working-stage visibility, textarea growth, diagnostics, keyboard order and retained Markdown-link focus. It does not claim native R7 or model acceptance. No test dependencies enter the product.
