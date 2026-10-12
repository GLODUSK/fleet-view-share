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
  `signed-in`, `refreshed` or `signed-out` and returns a function
  that stops it. No event carries a token or the key. A
  sign-in or sign-out by another process (the CLI) is heard the next time anything reads the sign-in.
- **`protectedStore(dir, name)`** keeps another secret the way the sign-in is kept: `<dir>/<name>.bin` with DPAPI,
  the Keychain under account `<name>`, or `<dir>/<name>.json` at `0600`. It returns `{ read, write, clear, stamp }`
  over plain text. The name is 1 to 41 of `[a-z0-9-]`, and `session` is refused because that is the sign-in's own.

## The start screen: work locally, or sync with Blackbox (Henry's machines)

Henry's own checkouts have `private.json` (`scripts/publish-share.js` leaves it out of the share repo, so a friend's
install never asks and its sync stays off):

```
{ "syncName": "Blackbox", "syncEmail": "<the one Google account>", "syncUrl": "https://<project>.supabase.co",
  "syncKey": "<the publishable key>" }
```

On them, before the page shows anything, a full-window start screen (`web/setup.js`, `sync-setup.js`) asks once, with
two big cards: **Sync with Blackbox** or **Work locally**. Choosing sync writes `config.json` from `syncUrl` and
`syncKey` by itself (the checks of `node sync-api.js setup`; a secret key in `private.json` is not taken), so no
address or key is asked. Sync then goes step by step, each one done before the next opens (**Back** shows the two
cards again):

1. **Sign in**: **Continue with Google**, sent straight to `syncEmail` (Supabase passes `login_hint` on to Google).
   Only that account may sign in on these machines (`sync-api.js` `onlyEmail`): another one is turned away at the
   callback, nothing of it is kept, and the screen says which account it was. A sign-in kept from before for another
   account counts as signed out. Without `syncEmail` (a friend's install) Google shows its account picker as before.
   A `private.json` without `syncUrl`/`syncKey` still shows the old **Connect** step first (`POST /sync/connect`).
   **No passphrase.** Once signed in, the server fetches the sync key from Blackbox by itself (see
   [The sync key](#the-sync-key)); the screen shows a spinner while it does, and **Try again** if it can't.
2. **Claude accounts**: each letter Blackbox has (A and B, the only ones a conversations row knows) signed in here as
   the same login. A login that is here under another letter (the C an old bug handed out instead of A) is moved to
   its letter by itself; a letter holding a login Blackbox does not want there is moved aside to a free letter first,
   so no login is lost. A missing one has a **Sign in as ...** button (the claude.ai link and a field for its code
   too, for a browser signed in to another claude.ai account). Claude B's folder (`~/.claude`) is never renamed, so
   a login goes onto or off B by signing in, and since one login is on one letter only, in order: B first (its
   button **Remove Claude C and sign in** removes the letter that has B's login now, backing that login up), then the
   letter that wants B's old login (**After Claude B** until then). A machine with B and C the other way round from
   Blackbox is two sign-ins.
3. **First sync**: what is on Blackbox comes here and what is here goes up; the screen closes by itself when both
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
   - **Sync key:** whether it is on this PC, or being fetched from Blackbox (nothing to type).
   - Below that it says whether sync is running (or why not), how many conversations are up to date, how many
     came from other machines, and how many conflicts there are. It never shows a title, a path, a token or the
     key.

   A remote browser (the phone, another computer) sees the card read-only: sign-in and sign-out are done on the PC. When sync is not set up yet, the card shows the setup command to copy.
3. Or from a terminal, the same steps: `node sync-api.js signin` (Fleet View must be running),
   `node sync-api.js status`, `node sync-api.js signout`, and `node sync-crypto.js key` (fetches the sync key now;
   sync does it by itself; `node sync-crypto.js status` says whether the key is here). To turn sync off again, run
   `node sync-api.js off`, which signs out and deletes the config.

The card's routes, all on this PC's own page only (not a remote browser, not another site's page):
`POST /sync/open-signin` and the existing `POST /sync/signout`; whether the key is here is in `GET /sync/setup`
(`hasKey`).

## The sync key

Everything that leaves a machine is sealed with one 32-byte key (`sync-crypto.js`, AES-256-GCM). The first machine
that signs in makes it at random and puts it in Blackbox itself: `fleet_sync.settings`, key `sync-key`,
`{ v: 1, key: <base64> }`. Every other machine fetches it on its first gate check after the sign-in
(`sync-crypto.js` `fetchKey`, called by `sync-run.js`) and keeps it in the protected store (`sync-key`, DPAPI /
Keychain / `0600`). Each later check reads Blackbox's `sync-key` again (one small GET): a key here that differs from
it (kept from before Blackbox's was made again) is replaced by Blackbox's and the loops restart with it, so a machine
never sits on a key nothing else opens; Blackbox not answering keeps the one here. Two machines making it at once:
the first row wins and both keep that one.

The trade-off (Henry, 2026-10-11: "remove passphrase step"): the key is guarded by the Google sign-in (only
`syncEmail` on Henry's machines) and the members list (RLS), not by a passphrase only Henry knows. Anyone who can
read the `settings` table as Henry, or with the project's service role, can open the synced chats.
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

## Repos this machine lacks (clone what's missing)

A conversation from a repo this machine has no checkout of is skipped (`/sync/activity`: "no checkout of its repo
here"). The materializer lists those repos (`sync-down.js` `missing()`), and `sync-clone.js` clones them, so their
chats come over. Nothing new goes to Supabase: it only reads the repos rows sync already has.

- **Ask once, then automatic** (Henry, 2026-10-11). The first time such repos exist, the page shows a card: the
  repos (each ticked), the folder they go in, "Clone new repos automatically from now on" (ticked), **Clone** and
  **Not now**. Not now keeps it quiet until a new repo goes missing. Once Henry clones with automatic on, each repo
  that goes missing later is cloned by itself, once (a repo he unticked never is). The Sync card's **Repos** part
  lists what is missing with a **Clone** button each, the switch, and the clone folder (**Change**).
- **Where:** the folder most of this machine's checkouts live in (`Z:\Github` on the PC, `~/code` on the Mac), else
  `~/code` on a Mac, else the home folder; the Sync card can pick another. A repo goes in `<folder>/<name>`, or
  `<name>-2` when that name is taken: never into a folder that is there, except one already holding a checkout of
  that very repo, which is simply added. The clone is made in a hidden folder beside it and renamed into place when
  complete, so a failed clone leaves nothing.
- **How:** `git clone` as the user, with no prompt: the machine's credential helper (the Keychain, gh) answers or the
  clone fails at once. For GitHub, `gh repo clone` is tried next when gh is here. Still refused: "Sign in to GitHub on
  this machine: gh auth login". The new checkout is added like **Add workspace…** (`POST /repos/add`), and the
  materializer scans again at once.
- **Dependencies**, in the background after the clone: `package-lock.json` runs `npm ci`, `pnpm-lock.yaml`
  `pnpm install --frozen-lockfile`, `yarn.lock` `yarn install --frozen-lockfile`, `bun.lock(b)` `bun install`. A
  missing tool or a failed install is a note, never a failed clone; the output goes to `<dataDir>/clone.log`. A
  checkout that was already there is left as it is.
- **Routes** (this machine's own page only; 404 while sync is not set up): `GET /sync/missing`, `POST /sync/missing
  { notNow?, auto?, folder? }`, `POST /sync/clone { origins, folder?, auto?, skip? }` (answers at once with a job),
  `GET /sync/clone?id=`. The policy is this machine's own (`~/.fleet-view.json` `syncClone`), never shared.

Test: `node scripts/sync-clone-test.js` (local bare repos stand in for GitHub, a fake Supabase for the rows).

## Linking machines

While sync runs, `sync-run.js` also runs the link (`link.js`, [link.md](link.md)) beside the mover: Henry links two of
his machines once in the Sync card (**Your machines**, **Link**, the same 6-digit code confirmed on both), and from then
on each can call the other's routes through the other's relay, the way the phone does. The sync key carries only the
pairing's rows; the keys the calls use come from the pairing, so the sync key alone never links a machine. With sync
off there is no link. Tests: `node scripts/link-test.js`.

## Friends' installs stay local

People who install Fleet View from the public share repo get no sync at all, and nothing they do can reach
Henry's project:

- The share repo holds no project URL, no key and no project ref (Henry's own repo keeps them in `private.json`,
  which never goes to the share repo). The config lives outside the repo, in each
  machine's own data folder, and only `setup` writes it. A friend's install has no config, so sync stays off.
  It makes no network call, starts no process or timer, and every `/sync` route except the status answers 404, as
  every `/link` route does.
- `scripts/publish-share.js` reads every outgoing file before a publish, and before a dry run too. It refuses
  to publish if a file holds a Supabase project URL, ref or key, a JWT, or a sync `config.json`. The test plants
  each of these in a throwaway repo to prove the refusal.
- Even someone with the URL and key in hand, signed in with Google, gets nothing back: the server's members
  list allows only Henry's accounts.
