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
   - **Publishing status → Publish app → "In production".** Confirm the
     "unverified app" warning. This is the step that stops refresh tokens
     expiring after 7 days (the reason Google Calendar was dropped before).
     Verification is *not* required for personal use; you will just see a
     one-time "Google hasn't verified this app" screen during sign-in →
     *Advanced → Go to idea-bridge (unsafe)*.
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

Open the printed URL in any browser on that PC, sign in, accept. The script
listens on `127.0.0.1:53682`, exchanges the code and writes
`.google-token.json` (gitignored). It prints the connected address.

If the PC's browser can't reach `127.0.0.1:53682` (some office policies), run
the script, copy the URL to your phone, finish the consent there, and paste the
final `http://127.0.0.1:53682/oauth2callback?code=...` URL into the PC browser.

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

- `invalid_grant` in `/status` → the token was revoked or the app was still in
  Testing when you signed in. Publish the app (step 3) and re-run
  `node setup-google.js`.
- `403 accessNotConfigured` → an API wasn't enabled in step 2.
- Gmail returns nothing → the account has no mail newer than the cursor; try
  `/inbox 72h` to look back further.
