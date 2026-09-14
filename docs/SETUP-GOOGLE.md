# Google setup (Gmail read · Sheets · Tasks) — one time, ~10 minutes

The bot uses one OAuth client and one refresh token for all three Google APIs.
No SDK, no service account, no Calendar scope (events go to Radicale).

## 1. Create the OAuth client

1. Open https://console.cloud.google.com → create a project (e.g. `idea-bridge`).
2. **APIs & Services → Library** → enable **Gmail API**, **Google Sheets API**, **Google Tasks API**.
3. **APIs & Services → OAuth consent screen**
   - User type: **External**. App name: anything. Support email: yours.
   - Scopes: add `gmail.readonly`, `spreadsheets`, `tasks`.
   - Test users: add `faras.fam@gmail.com`.
   - **Stay in Testing.** In theory, **Publishing status → Publish app →
     "In production"** is what stops refresh tokens expiring after 7 days,
     with just a one-time "Google hasn't verified this app" warning during
     sign-in (*Advanced → Go to idea-bridge (unsafe)*) — no real
     verification needed, for personal use. In practice, current Google
     Cloud Console has started routing that "Publish" click into an actual
     **branding verification review** (real domain ownership via Search
     Console, a substantive privacy policy, no login wall, matching app
     name) — a lot of overhead for an app only you will ever sign into,
     and one you can fail (see Troubleshooting). **Don't chase it.** Leave
     the app in Testing and accept the 7-day refresh-token expiry instead:
     `node setup-google.js` now opens the consent URL in your browser
     automatically, so re-authenticating weekly is one command + one click,
     not worth trading for a verification review.
4. **Credentials → Create credentials → OAuth client ID → Desktop app.**
   Copy the client ID and secret into `.env`:

```
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

## 2. Sign in from the bot PC

```
node setup-google.js
```

It opens the consent URL in your default browser automatically — sign in,
accept. The script listens on `127.0.0.1:53682`, exchanges the code and
writes `.google-token.json` (gitignored). It prints the connected address.
The URL is also printed to the terminal, in case nothing opens.

If the PC's browser can't reach `127.0.0.1:53682` (some office policies), run
the script, copy the printed URL to your phone, finish the consent there, and
paste the final `http://127.0.0.1:53682/oauth2callback?code=...` URL into a
browser on the PC.

**Staying in Testing (see step 1) means this expires after ~7 days** — put a
recurring reminder of your own to re-run this weekly. `/status` will show
`invalid_grant` under the Google line once it lapses, and any scheduled job
(reminder tick, digest, finance report) that hits it sends a distinct
"🔑 Google token kadaluarsa" alert to Telegram rather than failing silently.

## 3. Finance spreadsheet

Create a Google Sheet (any name). Optionally add a tab named **Template** with
your own formatting/formulas — row 1 must be the header row:

`Tanggal | Deskripsi | Kategori | Jumlah | Tipe | Akun | Sumber | Ref | Catatan`

Each month the bot copies **Template** to a new tab `YYYY-MM` (or creates a
plain tab with that header if there is no Template). Put the spreadsheet id
(the long string in the URL) in `.env`:

```
FINANCE_SHEET_ID=1AbC...xyz
FINANCE_AUTO_LOG=1        # log bank/e-wallet emails automatically (0 = ask with a button)
SPEND_CONFIRM=1           # /spend shows a confirm card first (0 = save immediately)
```

## 4. Google Tasks

Nothing to configure. Reminders go to a list named **Idea Bridge** (created on
first use; change with `GOOGLE_TASKS_LIST=`). Completing a task on your phone
is detected on the next 07:15 tick and rolls the reminder to its next date.

## 5. Check

Send `/status` to the bot — the Google line should say `token OK`.

## Troubleshooting

- `invalid_grant` in `/status` (or a "🔑 Google token kadaluarsa" alert from a
  scheduled job) → the refresh token expired (7 days in Testing) or was
  revoked. Just re-run `node setup-google.js` — see step 1 for why staying in
  Testing rather than chasing verification is the recommended path.
- Stuck in Google's branding/verification review after clicking Publish →
  cancel out of it (don't request re-verification, don't dispute the
  findings) and set Publishing status back to **Testing** if you can. A bare
  placeholder home page/privacy policy (e.g. a Google Sites page) is enough
  to get *past the form*, but not enough to pass an actual review — that
  needs real domain ownership, substantive privacy-policy content, and a
  public (no-login) page, which isn't worth it for a personal bot.
- `403 accessNotConfigured` → an API wasn't enabled in step 2.
- Gmail returns nothing → the account has no mail newer than the cursor; try
  `/inbox 72h` to look back further.
