# Office mailbox setup (Outlook / Exchange Online via Microsoft Graph)

The bot reads the office inbox with the **device-code flow**: no secret, no
redirect URL, works from a headless process. It only needs `Mail.Read`.

## Skipping this entirely

Everything below is optional. If your IT admin isn't reachable to grant
consent (Path A) and IMAP is also blocked or a free/personal Microsoft
account gets rejected (Path B), just don't set `MS_CLIENT_ID` — and set:

```
MAIL_PROVIDERS=gmail
```

in `.env`. Without this, the digest still tries Outlook every run (the
default is `gmail,outlook`), fails with "not connected", and shows that as
a noisy provider error on every digest card. `MAIL_PROVIDERS=gmail` stops it
from being attempted at all — the inbox digest, finance email detection, and
everything else keep working off Gmail alone. `/status`'s "Microsoft token"
row will just read "Not configured", which is expected and fine.

## Path A — Microsoft Graph (preferred)

1. Sign in to https://portal.azure.com with **any** Microsoft account
   (a free personal Azure account is fine — the app registration does not have
   to live in the Kemenkeu tenant).
2. **Microsoft Entra ID → App registrations → New registration**
   - Name: `idea-bridge`
   - Supported account types: **Accounts in any organizational directory (multitenant)**
   - Redirect URI: leave empty.
3. In the app: **Authentication → Advanced settings → Allow public client flows: Yes**.
4. **API permissions → Add → Microsoft Graph → Delegated → `Mail.Read`, `User.Read`, `offline_access`.**
5. Copy the **Application (client) ID** into `.env`:

```
MS_CLIENT_ID=xxxxxxxx-xxxx-....
MS_TENANT=organizations      # or the Kemenkeu tenant id if you know it
```

6. On the bot PC:

```
node setup-outlook.js
```

It prints `To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code XXXXXXX`. Do that on any device with the office account. The script writes `.ms-token.json`.

### If the tenant blocks it

Domain-joined ministry tenants often set *User consent for applications* to
"Do not allow". Then step 6 ends with `AADSTS65001` / "Need admin approval".
Options, in order of least hassle:

- Ask the tenant admin (Pusintek / unit TIK) to grant admin consent for the
  app — it is read-only mail access for one user. Send them the client id.
- Use **Path B** below.

## Path B — IMAP (fallback)

Works when the mail server allows IMAP with a password or app password
(on-prem Exchange, Zimbra, cPanel mail). Exchange Online has basic-auth IMAP
disabled, so this does not work for Microsoft 365 unless the admin enabled
OAuth IMAP.

```
npm install imapflow mailparser
```

```
IMAP_HOST=mail.kemenkeu.go.id
IMAP_PORT=993
IMAP_USER=nama@kemenkeu.go.id
IMAP_PASSWORD=...
IMAP_MAILBOX=INBOX
```

## Choosing providers

`MAIL_PROVIDERS` is a comma-separated list; the default is `gmail,outlook`
(IMAP is opt-in only — add it explicitly if you're using Path B). Every
listed provider that fails to fetch shows up as a per-provider error on the
digest card rather than hiding the others; `MAIL_PROVIDERS=gmail` is how you
drop a provider you're not using instead of seeing that every time. `/status`
shows each configured provider's connection state.

Nothing is ever written to the mailbox: no labels, no read-state changes, no
sending.
