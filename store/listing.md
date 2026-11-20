# Edge Add-ons listing

Text and images for the Microsoft Partner Center submission. Regenerate the images with `npm run store`; the logo comes from `npm run icons`.

## Package

`npm run zip`, then upload `.output/focusen-<version>-chrome.zip`.

## Properties

- **Category:** Productivity
- **Privacy policy URL:** https://github.com/rifkymol/focusen/blob/main/PRIVACY.md
- **Website:** https://github.com/rifkymol/focusen
- **Support contact:** https://github.com/rifkymol/focusen/issues
- **Mature content:** No

## Store listing (English)

**Name:** Focusen

**Short description** (from the manifest, shown in search results):

> Give a tab a deadline. Finish it and mark it done, or it closes after a warning — always restorable.

**Description:**

```
Open tabs are promises you made to yourself and never kept. Focusen gives each one a deadline. When time runs out, you either finish it or let it close, and you always get one second chance.

HOW IT WORKS
• Track a tab from the toolbar, the right-click menu, or Alt+Shift+K.
• Pick a timer: 15 minutes to 1 day, or Auto. On Auto, a YouTube video gets its own length so it never closes mid-video, and any other page gets a day.
• A few minutes before the deadline, a small card appears on the page (or a notification, if the tab is in the background) with Done and Keep +1h.
• Hit Done when you've read or watched it. Finished tabs are logged, with a count for today and your best day this week.
• Tabs that run out of time move to Expired and wait there for 7 days. Reopen one with a fresh timer, and a video picks up where you left off.

BUILT TO BE FORGIVING
• Six slots. A short list is the point: when it's full, finish or drop something first.
• A tab that is playing audio or is fullscreen is never closed. You get another warning instead.
• If your computer slept through a deadline, you get a fresh warning instead of losing the tab.
• Tracked tabs are found again after a browser restart.
• Keep +1h works three times per tab, so nothing can be put off forever.

PRIVATE BY DESIGN
Everything stays in your browser. Focusen has no account, no servers and no analytics, and it never sends your data anywhere. It only reads the address and title of tabs you choose to track, and the length of the YouTube video you're watching.

Light and dark themes. Keyboard shortcuts: Alt+Shift+K to track, Alt+Shift+D to mark done, Alt+Shift+F to open.

Focusen is free and open source (MIT): https://github.com/rifkymol/focusen
```

**Search terms** (if the form asks for them):

```
tab timer, tab manager, focus, productivity, close tabs, read later, too many tabs
```

## Images

| Field | File | Size |
|---|---|---|
| Store logo | `logo-300.png` | 300×300 |
| Small promotional tile (optional) | `promo-440x280.png` | 440×280 |
| Screenshots, in this order | `screenshot-1-deadline.png` … `screenshot-5-dark.png` | 1280×800 |

## Notes for certification

```
How to test:
1. Open any web page, click the Focusen toolbar icon, choose a 15 min timer and click "Track this tab". The tab now shows a countdown badge.
2. About 5 minutes before the deadline a card appears on the page with "Done" and "Keep +1h" (on non-YouTube sites a system notification is shown instead, unless in-page warnings are enabled in Settings).
3. When the timer ends the tab closes and appears in the popup under "Expired", where "Reopen with new timer" brings it back once.
4. On a YouTube video, the "Auto" timer uses the video's length.

Permissions:
- tabs: read the address and title of tracked tabs, find them again after a browser restart, and close or reopen them.
- alarms: wake the extension when a deadline is reached.
- storage: keep the tracked list and the Done/Expired history locally.
- notifications: warn before a background tab closes.
- contextMenus: "Track this tab", "Mark this tab done" and "Open link as a tracked tab" in the right-click menu.
- scripting: show the warning card on the page.
- Host access to youtube.com: read the length of the video being watched.
- <all_urls> is optional and only requested if the user turns on in-page warnings for all sites in Settings.

No data is collected or sent anywhere. No account or sign-in is needed. Source code: https://github.com/rifkymol/focusen
```
