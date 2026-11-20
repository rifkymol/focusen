import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Focusen',
    short_name: 'Focusen',
    description:
      'Give a tab a deadline. Finish it and mark it done, or it closes after a warning — always restorable.',
    permissions: ['alarms', 'storage', 'tabs', 'notifications', 'contextMenus', 'scripting'],
    // YouTube is the only site we read (video length) without asking.
    host_permissions: ['*://*.youtube.com/*'],
    // In-page warnings on every other site are opt-in from the settings page.
    optional_host_permissions: ['<all_urls>'],
    action: { default_title: 'Focusen' },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Open Focusen',
      },
      'track-tab': {
        suggested_key: { default: 'Alt+Shift+K' },
        description: 'Track the current tab',
      },
      'mark-done': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Mark the current tab done',
      },
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'focusen@focusen.app',
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
