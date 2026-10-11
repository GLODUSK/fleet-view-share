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
  `signed-in`, `refreshed`, `signed-out` or `key-saved` (the Sync card saved the sync key) and returns a function
  that stops it. No event carries a token or the key. A
  sign-in or sign-out by another process (the CLI) is heard the next time anything reads the sign-in.
- **`protectedStore(dir, name)`** keeps another secret the way the sign-in is kept: `<dir>/<name>.bin` with DPAPI,
  the Keychain under account `<name>`, or `<dir>/<name>.json` at `0600`. It returns `{ read, write, clear, stamp }`
  over plain text. The name is 1 to 41 of `[a-z0-9-]`, and `session` is refused because that is the sign-in's own.

## The start screen: work locally, or sync with Blackbox (Henry's machines)

Henry's own checkouts have `private.json` (`{ "syncName": "Blackbox" }`; `scripts/publish-share.js` leaves it out of
the share repo, so a friend's install never asks and its sync stays off). On them, before the page shows anything, a
start screen (`web/setup.js`, `sync-setup.js`) asks once: **Work locally** or **Sync with Blackbox**. Sync then goes
step by step, each one done before the next opens:

1. **Connect**: Blackbox's address and its publishable key, once per machine (`POST /sync/connect`, the same checks
   as `node sync-api.js setup`; a secret or `service_role` key is refused and the key never comes back to the page).
2. **Google**: Sign in with Google, on the members list.
3. **Passphrase**: chosen (twice) on the first machine, the same one on every other.
4. **Claude accounts**: each letter Blackbox has (A and B, the only ones a conversations row knows) signed in here as
   the same login. A login that is here under another letter (the C an old bug handed out instead of A) is moved to
   its letter by itself; a letter holding a login Blackbox does not want there is moved aside to a free letter first,
   so no login is lost. A missing one has a **Sign in as ...** button (the claude.ai link and a field for its code
   too, for a browser signed in to another claude.ai account). Claude B's folder (`~/.claude`) is never renamed: when
   B is in the way the screen says what to do by hand.
5. **First sync**: what is on Blackbox comes here and what is here goes up; the screen closes by itself when both
   sides have looked once (**Open now** skips the wait).

**Work locally instead** closes it at any step. The choice is kept in `<dataDir>/sync/mode.json`
(`{ mode: 'sync' | 'local', done }`); a machine that had sync set up before this existed counts as syncing and is
not asked. The Sync card switches it later (**Sync with Blackbox** opens the start screen again; **Work locally
instead** stops sync here) and, while syncing, says whether the Claude accounts match.

**Which login is which letter.** Blackbox keeps the list as one sealed settings row, `accounts`
(`sync-accounts.js`): `{ v: 1, letters: { A: { id, email }, B: { id, email } } }`, id being the login's account
uuid. The first machine to sync writes it from its own letters (and, when it has no A, a login it has on C, D, ...);
later machines only fill a letter it has no login for, never change one. Sync does not run until every letter
Blackbox has matches here (`sync-run.js` gate 4), so nothing is uploaded or laid down under the wrong account. On a
Mac the login itself is in the Keychain; after a letter moves, `claude auth status` checks it is still signed in,
and if not the start screen asks for that sign-in again.

Routes (`sync-setup.js`): `GET /sync/setup`, and on this PC's own page only `POST /sync/mode { mode }`,
`POST /sync/done`, `POST /sync/connect { url, key }` (private checkouts only) and `POST /sync/accounts/check`.
`POST /accounts/add` takes `{ letter }` to sign in a given free letter. Tests: `node scripts/sync-setup-test.js`,
`node scripts/sync-accounts-test.js`, `node scripts/accounts-test.js` (parts 11 to 13), `node scripts/sync-run-test.js`.

## Turning sync on (Henry's machines)

The start screen above does all of this. By hand:

1. Once per machine, with the project's URL and its **publishable** key (Supabase dashboard, Settings, API keys):

   ```
   node sync-api.js setup --url https://<project>.supabase.co --key <the publishable key>
   ```

   It refuses anything that is not an `https://<project>.supabase.co` address, and it refuses a secret or
   `service_role` key. It never prints the key.
2. The rest is done in the page: click **sync** in the header (next to **account**) to open the **Sync card**.
   - **Sign in with Google** opens `http://127.0.0.1:4777/sync/signin` in the default browser (the server
     starts it, so it is a real browser even when the page is in the Fleet View window; Google refuses sign-ins
     inside embedded windows). Pick a Google account on the members list. The card updates by itself and then
     shows "Signed in as ..." and whether the account is on the members list.
   - **Sign out** asks once more in the card, then signs this PC out.
   - **The sync passphrase:** the first machine chooses one (typed twice); every other machine types the same
     one, and a different one is refused. Only the derived key is kept on the PC (the same store the CLI uses),
     never the passphrase, and syncing starts at once.
   - Below that it says whether sync is running (or why not), how many conversations are up to date, how many
     came from other machines, and how many conflicts there are. It never shows a title, a path, a token or the
     key.

   A remote browser (the phone, another computer) sees the card read-only: sign-in, sign-out and the passphrase
   are done on the PC. When sync is not set up yet, the card shows the setup command to copy.
3. Or from a terminal, the same steps: `node sync-api.js signin` (Fleet View must be running),
   `node sync-api.js status`, `node sync-api.js signout`, and `node sync-crypto.js passphrase` (typed hidden, so
   not through `!`; `node sync-crypto.js status` says whether the key is here). To turn sync off again, run
   `node sync-api.js off`, which signs out and deletes the config.

The card's routes, all on this PC's own page only (not a remote browser, not another site's page):
`POST /sync/open-signin`, `GET /sync/passphrase` (`{ hasKey }`, and with `?first=1` whether this is the first
machine), `POST /sync/passphrase` (`{ passphrase, repeat? }`, at most 4 KB) and the existing `POST /sync/signout`.
Tests: `node scripts/sync-api-test.js` (the card's routes are in its "Sync card" part).

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
