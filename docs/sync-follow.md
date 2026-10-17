# Chats follow you between machines (plan)

Status: built 2026-10-11 (Henry: "do all of it"), every part below merged; not yet tried between the two real machines
(that needs both signed in to sync, which links them by itself, and the phone app's next build). It replaces an earlier draft that only passed
messages through to the machine running a chat.

What Henry asked for (2026-10-11): a chat can live on either machine and keeps its workspace. A repo that is on
GitHub can be on both machines, so its chats move with him. A workspace only one machine has (a P4V workspace on the
PC) keeps that machine as its host, and the other machine passes his messages to it. The phone follows whichever
machine hosts the chat. "We gotta make sure the parity and sync is perfect and either host should transfer all the
stuff they need to make stuff work."

## The main computer (Henry, 2026-10-17)

> "The whole pairing with a PC is picking a hero computer to work from… we don't move conversations left to right if
> we're paired… but we can clone a workspace that way I pick up the work elsewhere."

This replaces every **Continue on this machine** below: the page no longer offers it anywhere (right-click menu,
Session tab, chat box chips, offline cards), with or without a main computer picked. What is left of it below is
history; `/sync/move` stays on the server for older pages.

- **The main computer** (`settings.mainMachine`, shared through `sync-prefs.js` group `mainMachine`; `GET`/`POST
  /sync/main`, fleet-view.js syncMain) is picked in the Sync card ("Which one is the main computer?"). The card shows
  each machine **online / offline** (with "seen X ago") from the link's presence, not from whether they are paired.
- **New chats run on it.** On the other machine, New session (and an empty chat's pasted copy, and a queued message's
  New chat) starts it on the main computer: `POST /link/start` (`link-send.js`) → that machine's `POST /api/sessions
  { repoOf: { origin, name }, blank | prompt }`, in its own checkout of the repo. It shows here once sync lists it and
  is picked then (`web/app.js` startChat, pickWhenListed). The main computer offline, not linked, or without a
  checkout of the repo: it starts here, and a toast says why. Forks, Fork at a message, a dropped file's scratchpad
  and a new team lead still start here (they need this machine's copy of the conversation or its files).
- **No chat moves.** Typing into another machine's chat goes there (below), and when that machine is off its chats
  wait for it: "BlackBox is offline. Its chats come back when it's on."
- **Clone workspace to this machine** (a workspace's right-click menu, when the other computer has chats in it;
  `clone-workspace.js`, `POST`/`GET /sync/clone-workspace`, `web/clone.js`): this machine gets its **own copies** of
  that workspace's newest 20 chats, with new ids and this machine's checkout as their folder, and the other machine's
  uncommitted work laid into worktrees here. The originals stay on the main computer, untouched.
- Background sync still copies every log both ways, out of sight: the Sync card no longer shows downloads, conflicts
  or "brought here".

## The rule

Every chat has a **host**: the machine its Claude runs on. Only the host writes the chat's log, so the two machines
never end up with two versions of it (`sync-move.js`'s rule, kept).

Every chat's workspace is one of two kinds:

- **Portable:** a git repo with an origin (GitHub), or a folder under the home folder (sync's home row: scratchpads,
  bots). Both machines have it, or can clone it.
- **Bound:** only one machine has it and git can't bring it: a Perforce (P4V) workspace, a repo with no origin, a
  folder outside the home folder in no repo. Today sync doesn't carry these chats at all. From now on their logs are
  synced too, so the other machine lists them, marked "on BlackBox", and can read them.

**Remote by default (Henry, 2026-10-13).** Typing never moves a chat. Every chat stays on its host, and what Henry
types on the other machine goes to the host through the link, like a remote port to it: idle or working, portable or
bound. Sync still copies every log, so both machines list and read every chat. Why: the host already has the files,
the logins and the `node_modules`; moving all of that because of one line was wrong. A chat moves only when Henry asks:
**Continue on this machine** in the chat's right-click menu, or in its Session tab. (Until 2026-10-13 typing into an
idle portable chat moved it here first.)

What happens when Henry types into a chat on the machine that isn't its host:

| The chat | Its host | What happens |
|---|---|---|
| portable or bound, idle or working | on, linked | The message goes to the host (queued there while Claude works), and the chat stays there |
| any | on, not linked | Nothing is sent and nothing moves: "BlackBox isn't linked with this machine yet" (they link by themselves while both are on), with **Continue on this machine** as the other way |
| portable | off | Nothing moves by itself: "BlackBox is offline. Continue on this machine from its last copy?" A click moves it from what the host last uploaded, its code included (see "When the host is off") |
| bound | off | "This workspace is only on BlackBox, which is off". **Continue on this machine anyway** moves the conversation, but its files aren't here |

**Continue on this machine** (the right-click menu, the Session tab, the cards) moves it with everything it needs
(below), as moves always did. What only works in a session on the machine itself (a "/" command that opens a panel,
the mode and model buttons, Rewind and Edit, bash mode, attaching files that aren't images) says so, with the button.

**Pinned chats never continue on another machine.** A workspace's **Never continue on another machine…** (its
right-click → Workspace settings; `web/keeps.js`, the stays-on rules) pins its chats to one machine: "Stays on
BlackBox: it used Blender…". Typed elsewhere, a pinned chat's messages go there like any chat's; Continue on this
machine is offered disabled ("a rule keeps it on BlackBox"), and the Session tab has no move button. A chat pinned by
hand (an older page's "Keep on <host>") offers **Unpin and continue on this machine** instead: unpinned for good, then
moved like any chat. When the host is off, the offline cards offer the same for any pinned chat. ("Let it follow me"
and "Follows you … Keep on <host>" are gone with the old rule: nothing follows Henry now.)

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

A live handover can't happen if the host is asleep, crashed or lost power. So the host also uploads each portable
chat's work (item 2, sealed like the logs) at the end of every turn, every 2 minutes while a turn runs, and right
after it takes a chat over. Each time it first checks whether the work changed (one `git status`), and uploads only
then. Mid-turn it sends at most 8 MB that is not up already; more waits for the turn's end, and the next mid-turn
snapshot comes 10 minutes later, so a file that keeps changing never goes up every 2 minutes. The conversation itself goes up at most every 45 s mid-turn, and at once when a turn ends.

So with the old host dead, "Continue on this machine" (forced, "Use the cloud copy") gets:

- the conversation as of its last upload: at most about 45 s old;
- the code as of the newest snapshot: at most about 2 minutes old (plus the upload's own time);
- the secrets from the last time the machines were linked.

When the code is older than the conversation, the `[Fleet View]` note and the missing list both say so ("the code
here is as of 14:02 UTC, the conversation as of 14:05 UTC"). A turn that changed no code doesn't count: the host
notes when it last saw the work unchanged.

The other machine sees the old host offline about 2 to 2.5 minutes after it died (no heartbeat for 2 minutes), or
gets "no answer" 60 s after asking. The old host's lease does not hold the pickup up any longer than that: once the
host is offline and its lease has not moved for 2 minutes, the lease no longer counts, even if the dead host's clock
put it far ahead. A lease that moves again means the host is back and running the chat, and it holds the pickup
up again.

When the old host comes back, it sees the chat is the other machine's now:

- its uploader never writes the chat again (it checks the owner first);
- its session, if it survived (sleep), ends once Claude is idle;
- its copy of the log, with any lines that never went up, stays as a conflict, never merged;
- once that session has ended, its changes in that checkout go in a git stash named "fleet-view: taken over by
  <machine> while this machine was off" (never deleted). Not in the checkout Fleet View runs from, not where
  another live chat works, not before the session host's list is in, and not when HEAD moved since the snapshot
  (new commits or another branch there are newer work, so the checkout stays as it is).

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
- **Messages to a host:** for every chat another machine hosts (remote by default, 2026-10-13). These routes are already on the
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

**Linking, by itself (Henry, 2026-10-13):** every machine signed in to sync as Henry with the sync key links with
every other one within about a minute of both being on, with no code to compare and no click ("it should happen
because it's Fleet View on both PCs and that's it"). The sign-in and the sync key are the trust root, as for the logs
([link.md](link.md), "The locks"). **Unlink** on either machine ends it at once, and they stay unlinked until **Link**.

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
   as the phone's side in Node · Opus, high (done: #307)
2. Portable and bound: sync carries every chat's log, marks each portable or bound to its host, and the list shows
   it · Opus, medium (done: #310, and #311 keeps another machine's chats its own on a lost sign-in)
3. Carry the work: pack and unpack the branch, unpushed commits, changes, untracked files and worktree into the chat's
   own worktree, stash on the old host, upload at each turn's end, and `sync-carry-test.js` in CI on both systems (done:
   sync-work.js #306; moves carry it: sync-carry.js #314)
4. Carry the rest: `.env` files and logins (`gh`, `vercel`, `supabase`, MCP) over the link, the ready check, and the
   `[Fleet View]` note (done: #314: sync-carry.js, /peer/env and /peer/logins, /sync/note)
5. Clone what's missing: ask once per repo, then automatic, and install dependencies · Sonnet, medium (done: #308; by itself only from accounts the machine has a checkout from)
6. Follow you: typing moves a portable chat here (queued on the host while it works), bound chats go through the
   link, and the Chat tab shows which · Opus, high (done: #312). Changed 2026-10-13 to remote by default: every chat's
   messages go to its host, and it moves only on **Continue on this machine** (the right-click menu, the Session tab)
7. The phone follows the host: it pairs with both machines and sends each chat's messages to its host · Opus, medium (done: #309; ships with the app's next build)
8. Fleet View's parity: a Mac form of every CLAUDE.md step, chosen by the machine the chat runs on (done: #301)

## Decided

- ~~Chats follow Henry: the machine he types on hosts a portable chat (Henry, 2026-10-11).~~ Replaced: remote by
  default. A chat stays on its host and the other machine sends to it; it moves only when Henry clicks **Continue on
  this machine** (Henry, 2026-10-13: one machine already has the files, the logins and the `node_modules`, so nothing
  should move because of one line).
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
  every 60 s (1 s while a pairing is under way). It is a commit-then-reveal X25519 exchange (as ZRTP and Bluetooth's
  numeric comparison do): the requester writes `sha256(its public key)`, the other machine answers with its public
  key, and only then does the requester reveal its key. Both derive the keys with HKDF over the shared secret and
  the whole transcript. Since 2026-10-13 it runs by itself (no code to compare: each side confirms as soon as it has
  the keys; link.md "Who asks"). One handshake makes both directions: a
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
resume it as their own. A host known to be offline for more than 7 days (by its own `live:`/`bound:` rows' `at` and its
`devices.last_seen_at`; `sync-live.js`
`TIMING.boundStaleMs`) has its bound list ignored (the `bound:` row and the live row's copy): a chat only that list
marked bound (a checkout with no origin under its home folder) reads as portable again until the host is back. A chat
synced under the host's bound row (`bound:<device>` origin) stays bound.

**Follow you (item 6).** It uses `/sync/move` (as it is today, with the work), and `link.call(host, …)` for the
`/api/sessions/:id/…` routes in the table above, which the page reaches through `/link/send`, `/link/answer`,
`/link/interrupt`, `/link/now`, `/link/unsend`, `GET /link/activity`, `/link/menu`, and `/conversation` for a chat
hosted elsewhere.

As built (`link-send.js`, `web/compose.js` followPlan; docs/link.md "The Chat tab's routes"), and remote by default
since 2026-10-13, Send in the Chat tab of a chat another machine runs does one of these. Typing never moves it:

| The chat | What Send does |
|---|---|
| any, linked (portable or bound, idle or busy, a bot or not) | `/link/send`: it goes in there (queued there while Claude works or asks; resumed there when it isn't running) and the chat stays there. "Runs on <host>: your messages go there" (busy: "Working on <host>: what you send goes there"; bound: "Its workspace is only on <host>") |
| any, machines not linked | nothing is sent: "<host> isn't linked with this machine yet" (they link by themselves while both are on), with **Continue on this machine** (not for a bot: a move would lose the role) |
| host offline (the link's presence) | a card: "<host> is offline. Continue on this machine from its last copy?" (a forced move; a draft then goes in here), or for a bound one "Only on <host>, which is offline", with Continue on this machine anyway (the conversation, not its files) |

**Continue on this machine** in the chat's right-click menu (`web/app.js` continueItem, shown on the desktop window
while another machine hosts the chat and no move is under way) opens its Session tab, which starts the move (`term.js`
requestMove, `POST /sync/move`) and shows its phases, Cancel, Take over now and the rest, as that tab's own button
does. A pinned chat (`/state`'s `workspace.pin`): a rule's pin shows the item disabled (the server's move answers 409
`pinned` anyway); one pinned by hand (`pin.manual`) reads "Unpin and continue on this machine", and the tab first sends
`POST /sync/pin { id, mode: 'free' }` (keeps.js setPin), then the move. Once ready it opens here in the folder the move gives, and the move's `[Fleet View]` note goes before the next
message once (`GET /sync/note`, then `POST /sync/note { id, done: true }`).

While it runs there, the box reads that machine: the activity line and the question cards from `/link/activity` and
`/link/menu` (every 1.5 s while Claude works there, else 5 s), and the card's answers, Stop, the queue's Interrupt and
Unsend, and images go there. Rewind and Edit, bash mode, a "/" command that opens a panel, the permission mode, the
model and Remote Control say "… Continue on this machine to use this" with the button. The feed reads the host while
the link is up (`source`). The Session tab's card adds "Or just type in the Chat tab: your messages go to <host>, and it
runs there."
