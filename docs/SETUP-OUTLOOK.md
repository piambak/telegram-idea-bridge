# Office mailbox setup (Outlook / Exchange Online via Microsoft Graph)

The bot reads the office inbox with the **device-code flow**: no secret, no
redirect URL, works from a headless process. It only needs `Mail.Read`.

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

`MAIL_PROVIDERS=gmail,outlook` (default tries gmail, outlook, imap and uses
whichever is connected). `/status` shows each one.

Nothing is ever written to the mailbox: no labels, no read-state changes, no
sending.
