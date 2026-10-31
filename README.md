# Contacts Groups

An installable web app (PWA) for Android and PC that edits your Google Contacts directly through the Google People API.

- **Εξομολόγηση tab**: everyone in the group, with name, phone, a tick box and a notes box. Untick to remove someone.
- **Other contacts tab**: everyone not in the group, filterable by "No group" or by another group. Tick someone to add them and a notes box appears.
- **Edit**: change full name, first phone number and notes, or delete the contact.
- **Search** ignores capitals and accents, and says how many more matches are in the other tab.

There is no server. The app runs in your browser, signs in with Google, and talks to Google directly. It keeps no copy of your contacts; only the Client ID and group name are saved in the browser.

## Keyboard (PC)

| Key | Action |
| --- | --- |
| `/` | Search |
| `↑` `↓` (or `j` `k`) | Move between contacts |
| `Space` | Tick / untick |
| `n` | Jump to notes |
| `Enter` or `e` | Edit contact |
| `Esc` | Leave a text box |
| `1` / `2` | Switch tabs |
| `r` | Reload from Google |
| `Delete` | Delete the selected contact (asks first) |
| `Ctrl+Enter` | Save in the edit window |

Notes save by themselves 1.5 seconds after you stop typing, or when you leave the box.

## Hosting

Static files only. Served with GitHub Pages from the `main` branch root. The Google OAuth client must list the Pages origin (for example `https://<user>.github.io`) under *Authorized JavaScript origins*.
