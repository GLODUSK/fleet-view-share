# Sync: the connection (part S1)

Conversation sync keeps Henry's chats in his Supabase project so he can carry on with them on another machine.
This first part, `sync-api.js`, is only the connection. It syncs nothing by itself: the uploader (S2), the
download side (S3) and the page's sync card (S5) are built on it. Its test is `node scripts/sync-api-test.js`.

## What S1 adds

- **A per-machine switch.** Sync is on only when `<dataDir>/sync/config.json` exists (`%LOCALAPPDATA%\fleet-view\sync`
  on Windows, `~/Library/Application Support/fleet-view/sync` on a Mac). It holds the project URL and its
  publishable key, and nothing else. Without it Fleet View works exactly as before.
- **Sign in with Google**, through Supabase Auth with PKCE. The browser comes back to
  `http://127.0.0.1:<port>/sync/callback` on this PC, and Fleet View swaps the one-time code for a session.
- **The sign-in is kept protected.** On Windows it is encrypted with DPAPI for the Windows user
  (`sync\session.bin`). On a Mac it goes in the login Keychain. On Linux it is a `0600` file, which is not
  encrypted. The page and `GET /sync/status` never show a token or the key.
- **Routes:** `GET /sync/status` (the page and remote browsers may read it), and `GET /sync/signin`,
  `GET /sync/callback`, `POST /sync/signout`, which work only on the PC itself.
- **Helpers for S2 and S3:** `rest()` and `rpc()` on the `fleet_sync` schema, and `storage.upload`, `download`
  and `remove` on the private `fleet-sync` bucket. Every file path goes under the signed-in user's own folder
  (`<user id>/...`). A path with `..`, a leading `/` or a backslash is refused before anything is sent.
- **For other parts that need the account (the phone relay):** `accessToken()` (renewed first when less than a
  minute is left), `uid()`, `email()`, and `onChange(fn)`, which calls `fn({ type, uid, email })` with `type`
  `signed-in`, `refreshed` or `signed-out` and returns a function that stops it. No event carries a token. A
  sign-in or sign-out by another process (the CLI) is heard the next time anything reads the sign-in.
- **`protectedStore(dir, name)`** keeps another secret the way the sign-in is kept: `<dir>/<name>.bin` with DPAPI,
  the Keychain under account `<name>`, or `<dir>/<name>.json` at `0600`. It returns `{ read, write, clear, stamp }`
  over plain text. The name is 1 to 41 of `[a-z0-9-]`, and `session` is refused because that is the sign-in's own.

## Turning sync on (Henry's machines)

1. Once per machine, with the project's URL and its **publishable** key (Supabase dashboard, Settings, API keys):

   ```
   node sync-api.js setup --url https://<project>.supabase.co --key <the publishable key>
   ```

   It refuses anything that is not an `https://<project>.supabase.co` address, and it refuses a secret or
   `service_role` key. It never prints the key.
2. Sign in with Google, with Fleet View running:

   ```
   node sync-api.js signin
   ```

   This opens `http://127.0.0.1:4777/sync/signin` in the default browser. Use a real browser, because Google
   refuses sign-ins inside embedded windows. Pick a Google account on the members list. The page then says
   "Signed in as ...".
3. Check it: `node sync-api.js status`. To sign out, run `node sync-api.js signout`. To turn sync off again,
   run `node sync-api.js off`, which signs out and deletes the config.
4. Set the sync key, in a terminal (the passphrase is typed hidden, so not through `!`):

   ```
   node sync-crypto.js passphrase
   ```

   Use the same passphrase on every machine. `node sync-crypto.js status` says whether the key is here.

## Running (S2 and S3)

`sync-run.js` starts the uploader (`sync-up.js`) and the materializer (`sync-down.js`) inside the server once all
three are true: the config is there, a member is signed in, and the sync key is on this machine. It stops them on
a sign-out, and restarts them when another account signs in or the key changes. It looks again on every sign-in
change and once a minute. `GET /sync/activity` shows whether they run (or why not) and their counts, never a
title, a path inside a conversation, a token or the key. Conflicts (a local copy longer than, or different from,
the synced one) are listed there and left alone. The wire format is `docs/sync-format.md`. Tests:
`node scripts/sync-common-test.js`, `sync-up-test.js`, `sync-down-test.js`, `sync-run-test.js` (all in `scripts/`).

The server decides who may sync, not this code. The `fleet_sync.members` list is checked by every table policy
and every storage policy. A Google account that is not on the list can sign in, but it reads and writes nothing.
The page tells it so.

## Friends' installs stay local

People who install Fleet View from the public share repo get no sync at all, and nothing they do can reach
Henry's project:

- The repo holds no project URL, no key and no project ref. The config lives outside the repo, in each
  machine's own data folder, and only `setup` writes it. A friend's install has no config, so sync stays off.
  It makes no network call, starts no process or timer, and every `/sync` route except the status answers 404.
- `scripts/publish-share.js` reads every outgoing file before a publish, and before a dry run too. It refuses
  to publish if a file holds a Supabase project URL, ref or key, a JWT, or a sync `config.json`. The test plants
  each of these in a throwaway repo to prove the refusal.
- Even someone with the URL and key in hand, signed in with Google, gets nothing back: the server's members
  list allows only Henry's accounts.
