# Instructions for AI agents

You were probably given this repo's URL by someone who wants to change their workout timer app. They are likely not a programmer. Make the change they describe, explain what you did in plain words, and tell them how to see it.

## What this is
Iso Tracker: a hands-free timer and log for isometric holds. Plain HTML, CSS and JavaScript. No build step, no framework, no server, no account. History is stored in the browser (IndexedDB), on the user's own device.

## Layout
- `index.html` loads `js/app.js`. `css/app.css` is all styling.
- `js/app.js` is every screen and button. Find the text on screen, search for it here.
- `js/engine.js` is the workout timer logic (phases, holds, skip, back). No DOM.
- `js/plan.js` has the default exercises and settings. `js/progress.js` has records, charts data, and the "raise the target" suggestions. `js/io.js` is export/import. `js/time.js` is time formatting.
- `tests/logic.test.mjs` tests the logic.
- `sw.js` caches files for offline use.

## Rules
1. Keep it simple. Smallest change that does what was asked. No new dependencies or build tools.
2. After editing any file listed in `sw.js`, bump the `CACHE` name there (`iso-tracker-N` to `iso-tracker-N+1`). Otherwise phones keep showing the old version.
3. Run `npm test` (needs Node 18+). It must pass. Add a test when you change timer or record logic.
4. Never delete or reset the user's data. Exercise and session data live in their browser, not in this repo.
5. Do not add tracking, accounts, or network calls. The app is deliberately local-only.
6. Style: short functions, comments explain why, not what. Match the surrounding code.

## To preview
```
python3 -m http.server 8765
```
Open `http://localhost:8765`. Opening `index.html` as a file will not work.

## If the user cannot edit this repo directly
Tell them to fork it on GitHub (the Fork button, top right), or to download the ZIP (Code, Download ZIP), and apply your changes there. Give them complete file contents or a clear before/after, not fragments.
