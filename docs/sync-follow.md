# Chats follow you between machines (plan)

Status: being built, from 2026-10-11 (Henry: "do all of it"). It replaces an earlier draft that only passed
messages through to the machine running a chat.

What Henry asked for (2026-10-11): a chat can live on either machine and keeps its workspace. A repo that is on
GitHub can be on both machines, so its chats move with him. A workspace only one machine has (a P4V workspace on the
PC) keeps that machine as its host, and the other machine passes his messages to it. The phone follows whichever
machine hosts the chat. "We gotta make sure the parity and sync is perfect and either host should transfer all the
stuff they need to make stuff work."

## The rule

Every chat has a **host**: the machine its Claude runs on. Only the host writes the chat's log, so the two machines
never end up with two versions of it (`sync-move.js`'s rule, kept).

Every chat's workspace is one of two kinds:

- **Portable:** a git repo with an origin (GitHub), or a folder under the home folder (sync's home row: scratchpads,
  bots). Both machines have it, or can clone it.
- **Bound:** only one machine has it and git can't bring it: a Perforce (P4V) workspace, a repo with no origin, a
  folder outside the home folder in no repo. Today sync doesn't carry these chats at all. From now on their logs are
  synced too, so the other machine lists them, marked "on BlackBox", and can read them.

What happens when Henry types into a chat on the machine that isn't its host:

| The chat | Its host | What happens |
|---|---|---|
| portable, idle | on | It moves here with everything it needs (below), then the message goes in |
| portable, working | on | The message is queued on the host. The chat moves the next time he types while it's idle, or now with **Take over now** |
| portable | off | It moves here from what the host last uploaded, its code included (see "When the host is off") |
| bound | on | The message goes to the host, and the chat stays there |
| bound | off | "This workspace is only on BlackBox, which is off". **Continue here anyway** moves the conversation, but its files aren't here |

The phone follows the same rules but never hosts: it sends each chat's messages to that chat's host.

## What a move carries

"Everything it needs to keep working", in this order:

1. **The conversation:** the log and its side files, as moves do today.
2. **The work:**
   - the branch and its commit;
   - the branch's commits that origin doesn't have (a git bundle);
   - staged and unstaged changes, including deletions, renames and binary files;
   - untracked files git doesn't ignore (but never `.env` files, even unignored ones: those travel as secrets, item 3);
   - the worktree, if the chat runs in one.

   The new host unpacks it into the chat's own worktree (see below), on the same branch and commit, then applies the
   changes. It checks that `git status` and a hash of the changes match what the old host sent before Claude starts.
   The old host then puts the same changes away in a stash named "moved to <machine> <time>", never deleted, so the
   work lives in one place. The next move brings it back the same way.
3. **Files git ignores that the repo needs to run:** `.env`, `.env.local` and `.env.*` by default, plus more per repo
   in Settings.
4. **Logins:** the tools the chat uses: `gh`, `vercel`, `supabase`, and the MCP servers (their entries in
   `.claude.json` and their sign-ins). Each is copied into the new host's own store (the Keychain on the Mac, Credential
   Manager on Windows). A login that can't be copied shows as "missing on this Mac", with the command to run. The
   Claude accounts are already set up on each machine by sync's start screen.
5. **Rebuilt, not copied:** dependencies (when `node_modules` is missing or the lockfile changed, the new host runs
   the repo's install), build output and caches.
6. **Not movable:** running processes such as a dev server or a watcher.
7. **A note to Claude.** When the chat starts on the new host, Fleet View types a `[Fleet View]` note: where it came
   from, the folder and branch, how many changes were applied, what is missing, and what was running on the old host.
8. **To test:** Claude Code's `file-history/<id>`, the backups `/rewind` uses to restore code. Today it isn't synced
   (`docs/sync-move-recipe.md`). Carrying it would let `/rewind` restore code after a move, but it holds absolute paths,
   so it needs testing in `scripts/sync-contract.js` first.

**Secrets travel only over the link** (items 3 and 4), never through Supabase's tables or storage. The link encrypts
with keys made when the two machines paired, and Supabase never has them. Copying logins is then not the same risk as
storing them in sync, where only the Google sign-in guards them. The new host keeps them, so a later move from the cloud
copy still has them.

**Ready check.** Before a move, the new host checks it has what the chat needs: the repo, the tools its CLAUDE.md and
scripts call (node, git, p4…), the logins and the env files. The move card shows what is missing. A portable chat whose
tools aren't here behaves like a bound one until they are.

## One chat, one worktree

A chat's changes can only be moved exactly when they belong to that chat alone. In a checkout several chats share,
the uncommitted changes belong to all of them, and putting them away on the old host would pull files out from under
the others. So:

- A portable chat that edits code gets its own worktree on the new host.
- A chat in a main checkout moves its changes only when no other live chat uses that checkout. Otherwise it asks:
  move them with it, copy them, or leave them.

## When the host is off

A live handover can't happen if the host is asleep. So the host also uploads each portable chat's work (item 2,
sealed like the logs) at the end of every turn. A pickup from the cloud copy then gets the code as of the last
finished turn. The secrets come from the last time the machines were linked. Anything newer is in the stash on the old
host, and the `[Fleet View]` note says so.

## Clone what's missing

A GitHub repo this machine doesn't have (the Mac skips 41 chats today: "no checkout of its repo here") is offered
once: "Clone GLODUSK/detailforge to ~/code/detailforge?" After that, new repos clone without asking, the repo's chats
come over, and its dependencies are installed. Settings has a clone folder per machine (the Mac's checkouts are in
`/Users/henry/code`).

## The link

The two machines talk through the phone's relay (`relay.js`, `docs/phone.md`): a private Supabase Realtime channel
carrying envelopes encrypted with a device key that only a pairing makes. Each machine runs `relay.js` already (it is
enabled on the Mac, with no devices yet). The new piece is `link.js`, the phone's side of the protocol in Node, so one
machine can call the other.

What it carries:

- **Live handovers:** the work, the secrets and the logins.
- **Messages to a host:** for a bound chat, or a portable one that's working. These routes are already on the
  relay's allowlist:

| The Chat tab does | The host's route |
|---|---|
| Send | `POST /api/sessions/:id/message` with `open: true` and `queue` |
| Answer a card | `POST /api/sessions/:id/answer` (`allowPermission` when Henry picks a permission option) |
| Stop | `POST /api/sessions/:id/interrupt` |
| Interrupt / Unsend a queued message | `POST /api/sessions/:id/now`, `/unsend` |
| Activity line, cards | `GET /api/sessions/:id/activity`, `/menu` |
| The feed, while on screen | `GET /conversation?id=…&since=…` (1.5 s while Claude works, 5 s idle, as the phone) |
| Image | `POST /chat/image` |

- **Online or not, at once:** the channel's presence, instead of the 2-minute heartbeat moves use now.

**Pairing, once:** in the Sync card on the Mac, **Link with BlackBox**. Both screens show a 6-digit code, and Henry
clicks **Allow** on BlackBox when they match. The handshake commits to its keys before the code shows (as
Bluetooth's numeric comparison does), so whoever carries the messages can't make the codes match. One step links both
ways. **Unlink** on either machine ends it at once.

## Parity: Fleet View itself on both

A moved chat is only as good as the rules it follows on the new host. Fleet View's CLAUDE.md ("Restart after every
update") is written for Windows: `Z:\Github\fleet-view`, `wscript`, `Get-Process`, `%LOCALAPPDATA%`. Each step needs
its Mac form, chosen by the machine the chat runs on. A merge must also reach both machines. The merging host
restarts itself, as CLAUDE.md says. The other machine takes the update from `updater.js`, which checks every
5 minutes and puts it in once no conversation is working. The ready check then holds every repo Henry moves to the
same standard (detailforge's CLAUDE.md and scripts too).

## How we know it's perfect

- **`scripts/sync-carry-test.js`**, built like `sync-contract.js`: two clones of a test repo stand in for the two
  machines, with a test chat that has a branch, an unpushed commit, staged and unstaged changes, a deletion, a
  rename, a binary file, an untracked file, `.env.local` and a worktree. It moves the chat there and back. Both
  checkouts must end byte for byte where they started (`git status --porcelain`, a hash of `git diff --binary HEAD`
  and of each untracked file). The conversation must continue with its context, with no line lost or doubled. It
  runs in CI on Windows and macOS.
- **By hand on the two machines:** a test chat in detailforge moves PC → Mac → PC mid-change, picks up from the cloud
  copy with the PC off, and a P4V chat is typed into from the Mac. The phone sends to a chat on each host.

## The build, in order

One item each, ready for "Go with these". Items 1 and 2 can start now. 3 needs 2. 4 and 7 need 1. 6 needs 1, 2 and 3.

1. The link: the machines pair once (a code on both screens) and call each other through the relay, with `link.js`
   as the phone's side in Node · Opus, high
2. Portable and bound: sync carries every chat's log, marks each portable or bound to its host, and the list shows
   it · Opus, medium
3. Carry the work: pack and unpack the branch, unpushed commits, changes, untracked files and worktree into the chat's
   own worktree, stash on the old host, upload at each turn's end, and `sync-carry-test.js` in CI on both systems · Opus, xhigh
4. Carry the rest: `.env` files and logins (`gh`, `vercel`, `supabase`, MCP) over the link, the ready check, and the
   `[Fleet View]` note · Opus, high
5. Clone what's missing: ask once per repo, then automatic, and install dependencies · Sonnet, medium
6. Follow you: typing moves a portable chat here (queued on the host while it works), bound chats go through the
   link, and the Chat tab shows which · Opus, high
7. The phone follows the host: it pairs with both machines and sends each chat's messages to its host · Opus, medium
8. Fleet View's parity: a Mac form of every CLAUDE.md step, chosen by the machine the chat runs on (done: #301)

## Decided

- Chats follow Henry: the machine he types on hosts a portable chat (Henry, 2026-10-11).
- A move carries everything the chat needs, logins and keys included (Henry, 2026-10-11). Secrets go only over the
  link.

## Still to decide

1. **Worktrees:** a moved chat that edits code gets its own worktree (recommended).
2. **Cloning:** ask once per repo, then automatic (recommended), or always automatic.
3. **Pairing:** a code on both screens (recommended), or a pasted link like the phone.

## For the builders: how the parts meet

Decided 2026-10-11 (Henry: "do all of it"): every recommendation above is taken. A moved chat that edits code gets
its own worktree; cloning asks once per repo, then is automatic; pairing is a code on both screens.

No Supabase migration: everything new lives in what sync already has, `fleet_sync.settings` rows (any key) and the
`fleet-sync` storage bucket under the user's own folder. The schema is in detailforge-web, which these machines
don't have checked out.

**Machines.** A machine is a sync device: `devices.id` (a UUID, kept in `<dataDir>/sync/device.json`), named by its
hostname. Everything below names a peer by that id.

**The link (item 1): `link.js`, and `relay.js` serving computers.**
- Pairing runs over `fleet_sync.settings` rows `link:<pid>:<step>`, sealed with the sync key like move rows, polled
  every 5 s (1 s while a pairing is under way). It is a commit-then-reveal X25519 exchange (as ZRTP and Bluetooth's
  numeric comparison do): the requester writes `sha256(its public key)`, the other machine answers with its public
  key, and only then does the requester reveal its key. Both derive the keys with HKDF over the shared secret and
  the whole transcript, plus a 6-digit code that both pages show. The pairing counts only once Henry confirms the
  code on **both** machines, since each one will run what the other sends. One handshake makes both directions: a
  key and device id for requester to answerer, and another for answerer to requester.
- Each machine's `relay.js` then keeps the other as a device of kind `computer` (`peer`: its sync device id) in
  `devices.json` and `relay-keys`, joins its channel, and serves it like a paired phone (envelopes, replays, parts,
  limits, the marker, the fence). The allowlist is the phone's plus `PEER_ALLOW`, the `/peer/...` routes items 3
  and 4 add, which a phone may never call.
- `link.js` is the phone's side of the protocol in Node (no npm package), taking the phone's place:
  `createLink({ api, key, dataDir, log, relay, device, now, timing })` returns
  `{ start, stop, status, peers, online(deviceId) -> true | false | null, call(deviceId, m, p, { q, b, etag,
  timeoutMs }) -> { s, b, b64, ct, etag }, request(deviceId), confirm(pid), unlink(deviceId) }`. `online` comes from
  the channel's presence.
- Routes on this machine's own page only: `GET /link/status`, `POST /link/request { device }`,
  `POST /link/confirm { pid }`, `POST /link/unlink { device }`. The Sync card lists the other machines, offers
  **Link**, shows the code, and has **Unlink**.

**The work (item 3): `sync-work.js`.**
- `inspect(cwd)` gives the chat's folder: `{ kind: 'portable' | 'bound', root, origin, branch, head, rel, worktree,
  dirty }`.
- `pack(cwd)` gives `{ manifest, blobs }`: the branch, head and merge-base with origin; a bundle of the commits origin
  lacks; the staged and the unstaged binary diffs; and untracked, unignored files (with their modes, never `.env*`).
  Every blob's sha256 is in the manifest.
- `unpack(manifest, blobs, { root, into })` gives `{ cwd }`. It never loses a commit, never touches a dirty checkout,
  and never force-moves a branch that has commits the head lacks.
- `verify(cwd, manifest)` checks a folder against a manifest, and `putAway(cwd, note)` makes the stash.
- In moves, A packs after the session ends and before `released`, and the final reply names the pack. B lays it down
  into the chat's worktree and verifies it before it claims, and `ready.cwd` is that folder. At each turn's end, the
  host uploads a portable chat's pack (sealed, in storage) for pickups while it is off. The format goes in
  `docs/sync-format.md`.

**Portable and bound (item 2).** `/state` gives each conversation `workspace: { kind: 'portable' | 'bound', host:
{ device, name } | null }`. A bound chat's log is synced too, so other machines list and read it, and they never
resume it as their own.

**Follow you (item 6).** It uses `/sync/move` (as it is today, with the work), and `link.call(host, …)` for the
`/api/sessions/:id/…` routes in the table above, which the page reaches through `/link/send`, `/link/answer`,
`/link/interrupt`, `/link/now`, `/link/unsend`, `GET /link/activity`, `/link/menu`, and `/conversation` for a chat
hosted elsewhere.

As built (`link-send.js`, `web/compose.js` followPlan; docs/link.md "The Chat tab's routes"), Send in the Chat tab of a
chat another machine runs does one of these:

| The chat | What Send does |
|---|---|
| portable, idle there | moves it here (`POST /sync/move`, its phase in the box's status line, Cancel), opens it here in the folder the move gives, then types the message here, with the move's `[Fleet View]` note before it once (`GET /sync/note`, then `POST /sync/note { id, done: true }`) |
| portable, busy there (working, or asking) | `/link/send`: queued there. "Sent to <host>: it's working there. This chat moves here once it's idle and you type again." |
| portable, busy there, machines not linked | moves it here anyway: the move waits until Claude is done there (or Take over now in the Session tab) |
| bound, or a bot or the Chief (a move would lose the role) | `/link/send`: it stays there. Not linked: "Link <host> in the Sync card to type here" |
| host offline (the link's presence) | a card: "<host> is offline. Continue here from its last copy?" (a forced move), or for a bound one "Only on <host>, which is offline", with Continue here anyway (the conversation, not its files) |

While it runs there, the box reads that machine: the activity line and the question cards from `/link/activity` and
`/link/menu` (every 1.5 s while Claude works there, else 5 s), and the card's answers, Stop, the queue's Interrupt and
Unsend, and images go there. Rewind and Edit, bash mode, a "/" command that opens a panel, the permission mode, the
model and Remote Control say "Continue here to use this" with the button. The feed reads the host while the link is up
(`source`). The Session tab's card adds "Or just type in the Chat tab: your messages go there."
