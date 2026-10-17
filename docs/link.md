# The link between machines (link.js)

Henry runs Fleet View on more than one machine (the PC, BlackBox, and the Mac), and they sync through Supabase
([sync.md](sync.md)). The link lets one machine call another's routes: send a message into a chat the other machine
runs, answer its questions, read its activity, and (as the plan in [sync-follow.md](sync-follow.md) goes on) hand over
the work a move carries. It is the phone's relay ([phone.md](phone.md)) with a machine in the phone's place:

- **`link.js`** is the phone's side of the protocol in Node, with no npm package. It joins the other machine's channel
  and sends envelopes up.
- **`relay.js`** on the other machine serves it as a device of kind `computer`, exactly as it serves a paired phone:
  envelopes, replays, parts, limits, the marker and the fence.
- **`realtime.js`** is the Phoenix channel client `link.js` joins with (the frames relay.js speaks from the serving
  side).

Each machine runs both halves, so a linked pair can call each other both ways. Nothing new goes in Supabase's schema:
pairing uses `fleet_sync.settings` rows, and calls go over the same private Realtime channels the phone uses.

**Linking is automatic** (Henry, 2026-10-13: "it should happen because it's Fleet View on both PCs and that's it").
Every machine signed in to sync as Henry and holding the sync key links with every other such machine by itself, within
about a minute of both being online: no code to compare, no click, nothing to do on the other machine. Henry only
presses **Unlink** to take a machine out, and **Link** to let it back in.

## The locks

1. **Supabase sign-in.** Both machines are signed in to sync as Henry. The channels are private (`fleet:<uid>:*`, only
   while `fleet_sync.is_member()`), and the pairing rows are his own settings rows.
2. **The sync key.** The pairing rows are sealed with it, so only a machine that holds it can ask, answer or read them.
   Sign-in and the sync key together are the trust root: the same two things that already guard every conversation log
   sync carries. A machine that has both is one of Henry's, and links.
3. **The keys a pairing makes.** The keys the calls use still come from an X25519 exchange (see "Pairing"), and the
   private halves never leave each machine's memory. So someone who can only read the rows (a copy of the settings
   table and the sync key) can't open the calls. Every call is AES-256-GCM under those keys, one per direction, as for
   the phone.
4. **The allowlist.** A computer may call what a phone may (`ALLOW`, with every narrower check), plus `PEER_ALLOW`: the
   `/peer/...` routes, which a phone may never call. The relay passes those on with the marker's key and the
   computer's peer (below), and Fleet View serves them only so.

What it no longer protects against (until 2026-10-13 Henry compared a 6-digit code on both screens, which did): someone
who stole the sync key **and** can sign in to sync as Henry can link a machine of his own, or stand in the middle of a
pairing and link each side with himself, and then call both machines' routes as Henry's phone can. Whoever has both can
already read and write every synced conversation, so the link adds no new way in. What it never protected against: a
process running as Henry on either machine (it can read the keys).

## Names

| Name | Meaning |
|---|---|
| machine id | a sync device id (`devices.id`, a lowercase UUID kept in `<dataDir>/sync/device.json`); the devices table names it by its hostname |
| R, A | the requester (see "Who asks") and the answerer |
| `pid` | one pairing: 16 hex digits |
| `dev` | a relay device id: 16 characters of b64u (12 bytes), as for a phone. A link makes two: R to A, and A to R |
| topic | `fleet:<uid>:<dev>`, as for a phone. The calling machine's link joins it with presence key `peer`, the serving machine's relay with `pc` |

## Who asks

Each machine, every time it reads the rows, looks at every other machine the devices table lists, and asks it to link
when that machine is:

- not linked with this one (no key for it in `peers.json`: a link both sides already keep is never made again);
- not unlinked by Henry (no `link-off` mark between the two, see "Unlinking");
- awake: its `last_seen_at` moved within the last 3 minutes on this machine's clock (the mover touches it every 30 s
  while sync runs there; a machine counts as awake from the moment this one first sees it, so each start asks once);
- with no pairing under way between the two.

**The lower device id asks** (the ids compared as strings), at once. The higher one waits 3 minutes first and asks only
when no ask came, so the two don't both ask, yet it still links when the lower one can't (an older Fleet View there, or
a link kept there that this machine lost). If both asked anyway (both pressed **Link** at the same moment), the lower
id's ask goes on: the higher machine drops its own (it deletes its rows: nobody answered them) and answers.

A pairing that did not link (it ran out, failed or was stopped) is asked again after 1 minute, then 2, 4 and so on up
to an hour, and at once when that machine's `last_seen_at` moves again after it was away. So a machine that was off for
days links within about a minute of coming back: it asks at its start when its id is the lower, and otherwise the other
machine sees it awake at its next read (every 60 s) and asks.

## Pairing

Rows in `fleet_sync.settings`, sealed with the sync key like the mover's (`sync-crypto.js sealText(json, key,
'setting:<key>')`), upserted on `(user_id, key)`, polled every 60 s, and every second while a pairing is under way
here (one asked here, or one the other machine asked for that this one took up at its last poll). So the other machine
sees a new ask within a minute, and the rest of the pairing runs at once:

| Row | Written by | Value |
|---|---|---|
| `link:<pid>:ask` | R | `{ v: 1, pid, from: R, fromName, to: A, commit, at }`, `commit` = b64u(sha256(`fleet-view link v1 commit` ‖ epkR ‖ nR)), nR 16 random bytes |
| `link:<pid>:answer` | A | `{ v: 1, pid, from: A, fromName, to: R, epk, at }`, epk A's X25519 public key (b64u) |
| `link:<pid>:reveal` | R, only after it read the answer | `{ v: 1, pid, epk, n, at }`: R's key and nR. A checks them against the commitment |
| `link:<pid>:ok-r`, `ok-a` | that side | `{ v: 1, pid, at }`: that side made the keys |
| `link:<pid>:done-r`, `done-a` | that side | `{ v: 1, pid, at }`: that side keeps the link now |
| `link:<pid>:no` | either | `{ v: 1, pid, by: 'r' \| 'a', why: 'declined' \| 'mismatch' \| 'expired' \| 'restarted', at }` |

1. **Ask.** R makes a fresh X25519 key pair and nR, and writes the ask. A answers only an ask addressed to it, from a
   machine the devices table lists and Henry did not unlink, at most 3 at once.
2. **Answer.** A makes its own key pair and writes the answer.
3. **Reveal.** R reads the answer and only then reveals its key and nR. A refuses a reveal that does not match the
   commitment (`no`, `mismatch`): nothing is linked. (The commitment made the codes Henry used to compare safe; with no
   code it only catches rows that were changed on the way.)
4. **The keys.** Both sides derive, from the X25519 shared secret (an all-zero one is refused) and the transcript T,
   which is the length-prefixed `fleet-view link v1`, pid, R, A, commit, epkA, epkR and nR:
   `salt = sha256(T)`, then HKDF-SHA256(shared, salt, info `fleet-view link v1 <x>`) for x in
   - `key r-a`, `key a-r`: 32 bytes each, R's calls to A and A's calls to R;
   - `dev r-a`, `dev a-r`: 12 bytes each (b64u), the relay device ids of those two.

   Each side writes its `ok` once it has them: R right after the reveal, A once it has checked the reveal.
5. **Keep.** A side keeps the link when it has written its own `ok` and sees the other's. Then:
   - its relay keeps the other machine: `relay.addComputer({ dev: the incoming id, name, peer, key: the incoming key })`,
     a paired device of kind `computer` in `devices.json` (no key) and `relay-keys`;
   - its link keeps the outgoing id and key: `<dataDir>/link/peers.json` `{ v: 1, peers: [{ peer, name, dev, pairedAt }] }`
     (no key), and the keys in `protectedStore(<dataDir>/link, 'link-keys')` (DPAPI, the Keychain or a 0600 file) as
     `{ <peer>: { dev, k } }`;
   - it writes `done-<side>`. A newer link with the same machine replaces the older one.

**Who deletes the rows.** The side that reads the other's `no` (after it took back a link it kept), R once it read
`done-a`, and A when its own pairing ran out. A side that says `no` leaves the rows for the other to read. So a link kept
on one side is never left there alone: the other side keeps it too or says no. Rows of a pairing nobody finished are
deleted 10 minutes after it ended.

**Running out and restarts.** A pairing runs out 10 minutes after it began on each side's own clock (never compared with
the other machine's). R then says `no` (`expired`), A drops what it has. The private keys live in memory only: an ask
this machine answered (or made) before it restarted is answered `no` (`restarted`). **Unlink** during a pairing says
`no` (`declined`). Either way, "Who asks" asks again later by itself.

Links made before 2026-10-13 (with the code) are kept as they are: `peers.json` and the relay's keys don't change, so
nothing links again.

## Calls

Each linked machine is one channel, `fleet:<uid>:<the outgoing dev>`, joined while the link runs. The envelope, its
keys (`dirKey` up and down of the outgoing key), the AAD, compression, parts (at most 64, 20 a second up), the 5-minute
skew and the 10-minute nonce window are [phone.md](phone.md)'s, with the link in the phone's place.

- **Hello.** On every join the link says `hello` (no `epk`) and reads the other machine's name and version from the
  answer.
- **Online.** `online(id)` is the channel's presence: `true` while the other machine's relay is on it (key `pc`),
  `false` when it is not (it drops at once when that relay's socket goes), `null` while not linked or not joined yet.
- **`call(id, m, p, { q, b, etag, timeoutMs })`** sends a `req` and waits for its `res`. The same `id` goes again (a new
  nonce and `at`, the same `t0`) every 8 s, after every rejoin, and when the other machine's relay comes back. The relay
  answers a repeat from what it kept, so a POST never runs twice, and one it can't be sure of gets 409 `restarted` or
  `expired`. It waits for the relay's time for that route ([phone.md](phone.md), "Timeouts") plus 5 s, or `timeoutMs`.
- **Answers.** The other server's answer as it came: `{ s, b?, b64?, ct?, etag? }`, a 429's `retryAfter` and the
  relay's own errors included. When no answer came, `s` is 0 and `b` is `{ ok: false, code, message }`, with code
  `not_linked`, `offline`, `timeout`, `pc-restarted` (the notice `pc-closing` came: a POST may have gone in), `revoked`,
  `stopped` or `too_large`. A call never rejects.
- **The marker.** What a linked computer sends on the routes api.js reads it on counts as Henry's, as from his phone
  (`via: "phone"` and `X-Fleet-View-Relay`).

## The /peer/ routes

`PEER_ALLOW` in relay.js lists them. Only a computer may call them, and the relay sends each one on with the marker's
key (`X-Fleet-View-Relay`, api.js's in-memory `relayKey()`) and `X-Fleet-View-Peer: <the caller's machine id>`.
fleet-view.js serves `/peer/*` only with both (`peerRoute`), so not this machine's own page, not a remote browser, and
not a script that only has the API token reaches them.

| Route | Answer |
|---|---|
| `GET /peer/status` | `{ ok, device: { id, name }, version, peer }`: who answers, and who asked |
| `POST /peer/env { id }` | `{ ok, files: [{ path, b64 }] }`: the env files of the work this machine is handing conversation id to the caller (paths from the checkout's top; plain files inside it, at most 1 MB each and 4 MB in all) |
| `POST /peer/logins { id }` | `{ ok, logins: { gh?: { token, user }, vercel?: { token }, supabase?: { token }, npm?: [line], mcp?: { user, project, local } } }`: the sign-ins this machine has for those tools (npm: the auth lines for the registries the repo uses; mcp: the account's remote servers, and the local ones' names) |

`/peer/env` and `/peer/logins` answer only while this machine hands that very conversation to that very machine (its
move is uploading or released: `sync-move.js` `peer`), 403 at any other time, 12 calls a minute from one machine
(429), and the relay passes on a body of `{ id }` alone. The machine that asked writes the env files into the moved
chat's folder (never over a different one: that one stays, the new one goes beside it as `<name>.from-<machine>`) and
signs in only where it has no sign-in (gh with `gh auth login --with-token` on stdin; Vercel's auth.json and Supabase's
access-token file, 0600; npm's lines added to ~/.npmrc; remote MCP servers with `claude mcp add-json`). Logs name the
files and tools, never what is in them.

## Unlinking

**Unlink** (`POST /link/unlink { device }`) on either machine:

- a pairing under way with that machine stops (`no`, `declined`);
- its relay revokes the other machine (`removeComputer`: the notice `revoked`, then the key is gone), and its link forgets
  its key;
- the other machine's link hears `revoked` on its channel and unlinks too, at once;
- it writes the mark `link-off:<the lower id>:<the higher id>` `{ v: 1, by, devs, at }` (`by` the machine where Henry
  pressed it, `devs` the relay ids of the link it took away). While the mark is there **neither machine links with the
  other by itself**, and neither answers the other's ask. A machine that was off unlinks when it reads it (only a link
  whose ids are in `devs`), and the mark stays.

**Link** (`POST /link/request { device }`) on either machine deletes the mark and asks at once, whichever id is lower;
from then on the two link by themselves again. It is also how to link now a machine that did not link by itself.

When the mark could not be written, this machine keeps it in memory (it does not link with that one until it restarts)
and logs why. Versions before 2026-10-13 wrote `link-gone:<to>:<from>` `{ v: 1, from, to, devs, at }` instead: the
machine it names still unlinks when it reads it (only a link whose ids are in `devs`) and deletes it, but it leaves no
mark, so the two then link again by themselves.

`node relay.js revoke <dev>` on a computer's device unlinks both too, with the mark (fleet-view.js `onComputerGone`).

## Routes and the page

`/link/*` serve this machine's own page only: never a remote browser or another site's page, POSTs with its Origin.
While sync is not set up here (a friend's install) they answer 404, as `/sync/*` do, and the link runs only while sync
does (`sync-run.js`: set up, signed in, the key here), beside the mover, whose device id it uses.

| Route | Does |
|---|---|
| `GET /link/status` | `{ running, me, machines: [{ id, name, platform, lastSeenAt, linked, online, pairedAt, version, unlinked, linking }], pairings: [{ pid, role, peer, state, message?, at }] }`, or `{ running: false, reason }` |
| `POST /link/request { device }` | **Link**: delete the unlink mark and ask that machine now: `{ ok, pid }` (409 while a pairing with it is under way) |
| `POST /link/unlink { device }` | **Unlink**: unlink it, here and there, and leave the mark: `{ ok, linked }` (`linked`: there was a link to take away) |

A machine's `unlinked`: Henry unlinked it (the mark). `linking`: not linked and not unlinked, and it links by itself (a
pairing is under way, or it is awake). Neither, and not linked: it is away, and links once it is back. A pairing's
state: `asking` (R waits for the answer), `waiting` (A waits for the reveal), `linking` (this side made the keys and
waits for the other's `ok`), then `linked`, `declined`, `failed`, `expired` or `cancelled`.

The Sync card (`web/sync.js`) lists the other machines under **Your machines**, each with one pill: **linked · online**,
**linked · offline**, **linking…**, **unlinked** or **offline** (not linked, not seen lately), and when it was last seen
for one not linked. **Unlink** (after a second click) shows for one linked or linking, **Link** for one unlinked or
away. Under a machine: that it just linked, or why its last pairing did not link ("It tries again by itself"), and for an
unlinked one that it stays so until Link. Nothing waits for Henry, so the card never opens by itself. The phone card
(`web/phone.js`) leaves computers out of its list.

### The Chat tab's routes (typing into a chat the other machine runs)

`link-send.js` (docs/sync-follow.md item 6, "Follow you"). For a chat another machine runs (sync-run.js `owners()`),
the Chat tab sends, answers, stops and reads it through these, and each goes to that machine's own route through the
link (`call()`), so its relay checks it and marks it as Henry's like the phone's. Only the fields listed go on. Every
chat another machine hosts goes through these, portable or bound, idle or busy: typing never moves it (remote by
default, Henry 2026-10-13), and since 2026-10-17 nothing in the page moves one (the main computer:
docs/sync-follow.md). `POST /link/start` starts a new chat on the main computer, in its own checkout of the repo
(`POST /api/sessions` with `repoOf`), after a `GET /peer/status` there that must answer within 12 s (else 503
`no_answer` and nothing is sent: presence can still say a sleeping machine is online). Once that answered, a start
that gets no answer (a time-out, or the machine gone offline meanwhile) is 504 `timeout`: it may still start there, so
the page starts no second one here.

| Route | Goes to (on the host) |
|---|---|
| `POST /link/send { id, text }` | `POST /api/sessions/:id/message { text, queue: true, open: true }`: queued behind a menu, resumed there when it isn't running |
| `POST /link/answer { id, option, sig?, text?, allowPermission? }` | `POST /api/sessions/:id/answer` (the page sets `allowPermission` only when Henry picks a permission prompt's option himself) |
| `POST /link/interrupt { id }` | `POST /api/sessions/:id/interrupt` (Stop: Esc once) |
| `POST /link/now { id }`, `POST /link/unsend { id, text }` | `POST /api/sessions/:id/now`, `/unsend` |
| `GET /link/activity?id=`, `GET /link/menu?id=` | `GET /api/sessions/:id/activity`, `/menu` |
| `POST /link/image { id, data, mime }` | `POST /chat/image` (`{ path }`: saved there) |

The host's answer comes back as it is. When it can't be reached the answer is `{ ok: false, code, message }`: `bad_id`
or `bad_request` 400, `not_elsewhere` 409 (this machine runs it), `moving` 409, `not_running` 409 (sync isn't running
here), `not_linked` 409 ("<host> isn't linked with this machine yet: they link by themselves while both are online (press Link
in the Sync card if you unlinked it)"), `revoked` 409, `pc-restarted` 409, `too_large`
413, `bad_answer` 502, `offline` 503, `stopped` 503, `timeout` 504.

`GET /conversation?id=` for such a chat is read on the host through the link while the link to it is up (online), and
says `source: '<host's name>'`; otherwise this machine's synced copy answers with `source: 'local'`. Only this
machine's page goes on to the host (`Sec-Fetch-Site: same-origin`, which the relay never sends), so a phone's read
never chains to a third machine. The feed (`web/chat.js`) loads the list again from the start when `source` changes.

Tests: `node scripts/link-send-test.js` (the routes, with a fake link and owner list) and `node
scripts/follow-plan-test.mjs` (what the Chat tab's Send does).

## Off

With sync off there is no link: no socket, no timer and no key read. With sync on and nothing linked, the link reads
its rows every 60 s (every second while it pairs) and opens no socket. The link's keys are read only while
`peers.json` lists a machine.

## Tests

`node scripts/link-test.js` (about a second, no network): two machines, each with a real relay.js and link, over a fake
Supabase (the tables, the mover's `last_seen_at` heartbeat, and a Realtime hub with presence), with a fake Fleet View
server each. It covers linking by itself (the lower id asks with no click, the other machine started later links within
a minute, one pairing only, the keys agreeing across the two machines, the rows deleted), calls both ways
(`/peer/status` with the marker and the peer header, a message with the marker, parts down and up, a 429, a lost answer
asked again with the same id and run once), a phone refused the `/peer/` routes, presence, unlink at once and sticking
for ten minutes, Link after it from the higher id, unlink while the other machine is off (the mark read when it comes
back), a restart keeping the link, an older version's gone row, a reveal that does not match its commitment refused and
the retry linking, both pressing Link at once, and with machines that never answer: the higher id waiting before it
asks, running out, a machine away not asked again and asked at once when it is back, and the pace. `node
scripts/relay-test.js` still checks the relay for phones.
