# Focusen

Give a tab a deadline. Finish it and hit **Done**, or it closes after a warning and waits in **Expired**, where you can bring it back once.

A Manifest V3 browser extension for Chrome, Edge and Firefox, built with [WXT](https://wxt.dev) and TypeScript. It has a popup with Active, Done and Expired lists, an in-page warning before a tab closes, notifications, and light and dark themes.

## How it behaves

- **Track this tab** from the popup, the page context menu, or `Alt+Shift+K`. Pick a timer: **Auto** (a YouTube video gets its length, capped at 1 day; any other page gets the default of 1 day) or 15 min to 1 day.
- **6 slots.** When the list is full, Focusen asks you to finish or drop a tracked tab first.
- **Warning before closing.** 5 minutes before the deadline (half the timer for very short ones, never less than 1 minute), you get an in-page overlay if the tab is in front, or a sticky notification otherwise. Both offer **Done** and **Keep +1h** (3 times per tab). A tab that is playing audio or is fullscreen at close time gets another warning cycle instead of being closed.
- **Nothing disappears.** Done tabs are logged under Done, with Undo. Closed tabs go to Expired with **Reopen with new timer (1× only)**, and a YouTube video reopens at the point you left it. Expired entries are deleted after 7 days.
- **24 hours is the hard cap** for every tab, YouTube or not, measured from when you started tracking it. Only Keep +1h extends past it.

## Architecture

| Piece | File |
|---|---|
| Pure deadline logic, `step(record, settings, now)` | `src/lib/deadline.ts` |
| Storage (source of truth, serialized writes) | `src/lib/store.ts` |
| Background: `reconcile()`, alarms, re-matching tabs after restart, badges, notifications, actions | `src/entrypoints/background.ts` |
| YouTube length from `<video>.duration` (ads, live and Shorts handled, SPA navigation) | `src/entrypoints/youtube.content.ts` |
| In-page warning (Shadow DOM, `alertdialog`, focus trap, Esc) | `src/entrypoints/overlay.ts` |
| Popup and settings | `src/entrypoints/popup`, `src/entrypoints/options` |

- `chrome.alarms` only wake the worker. Every wake re-reads `storage.local`, re-matches records to tabs, and runs `step()` on each record. A missed deadline (sleep, browser closed) starts a fresh warning and never closes the tab instantly.
- Tab IDs don't survive a browser restart. When `storage.session` is empty, which means a new browser session, every record is re-matched by URL, then by title and host. A record still unmatched after 2 minutes moves to Expired as "Lost after a restart", where it can be reopened.
- The YouTube length only sets a *minimum* deadline. Pausing or seeking never shortens it, and a new video from autoplay recomputes it while the 24 h cap stays anchored to the start.

Permissions: `alarms`, `storage`, `contextMenus` and `scripting` show no install warning. `notifications` and `tabs` do, and `tabs` is needed to re-match tabs and fill the restore list. Host access is limited to `*://*.youtube.com/*`. In-page warnings on other sites are opt-in: the settings page requests `<all_urls>` as an optional permission. No data leaves the browser.

## Develop

```powershell
npm install
npm run dev            # Chrome with hot reload
npm run dev:firefox
npm test               # unit tests (deadline logic)
npm run e2e            # builds, then drives real Chromium with the extension loaded
npm run build          # .output/chrome-mv3
npm run build:firefox  # .output/firefox-mv3
npm run zip; npm run zip:firefox
npm run icons          # re-render public/icon/*.png
```

To load the extension unpacked, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`.

The end-to-end test serves a fake `www.youtube.com` watch page through Playwright request routing, so it never touches the network. By default it uses the Playwright Chromium in `%LOCALAPPDATA%\ms-playwright`; set `CHROMIUM` to point it at a different build.

## Roadmap

- `_locales` / i18n, first-run onboarding, a done-vs-expired stats view beyond the weekly line.
- Store listings: privacy policy hosting (text in `PRIVACY.md`), CWS Privacy tab, Edge and AMO submission (`wxt submit`).
- Live checks still open: the packed-extension alarm floor (30 s vs 1 s), the current YouTube `ad-showing` and `.ytp-live-badge` selectors, and whether `action.openPopup()` works from a keyboard shortcut on every browser.
