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

## The locks

1. **Supabase sign-in.** Both machines are signed in to sync as Henry. The channels are private (`fleet:<uid>:*`, only
   while `fleet_sync.is_member()`), and the pairing rows are his own settings rows.
2. **The keys a pairing makes.** The sync key opens the pairing rows, but the sync key alone never links a machine:
   anyone who can read the settings table as Henry has it. The keys come from an X25519 exchange whose 6-digit code
   Henry compares on both screens, and the requester commits to its key before it sees the other's, so whoever carries
   the rows can't make the two codes match (see "Pairing"). Every call is AES-256-GCM under those keys, one per
   direction, as for the phone.
3. **The allowlist.** A computer may call what a phone may (`ALLOW`, with every narrower check), plus `PEER_ALLOW`: the
   `/peer/...` routes, which a phone may never call. The relay passes those on with the marker's key and the
   computer's peer (below), and Fleet View serves them only so.

What it does not protect against: a process running as Henry on either machine (it can read the keys), and Henry
confirming a code without looking at the other screen. A machine that holds the sync key can still make noise (a link
request shows on the other machine's page; an unlink row unlinks), never a link.

## Names

| Name | Meaning |
|---|---|
| machine id | a sync device id (`devices.id`, a lowercase UUID kept in `<dataDir>/sync/device.json`); the devices table names it by its hostname |
| R, A | the requester (the machine where Henry pressed **Link**) and the answerer |
| `pid` | one pairing: 16 hex digits |
| `dev` | a relay device id: 16 characters of b64u (12 bytes), as for a phone. A link makes two: R to A, and A to R |
| topic | `fleet:<uid>:<dev>`, as for a phone. The calling machine's link joins it with presence key `peer`, the serving machine's relay with `pc` |

## Pairing

Rows in `fleet_sync.settings`, sealed with the sync key like the mover's (`sync-crypto.js sealText(json, key,
'setting:<key>')`), upserted on `(user_id, key)`, polled every 5 s (every second while a pairing is under way):

| Row | Written by | Value |
|---|---|---|
| `link:<pid>:ask` | R | `{ v: 1, pid, from: R, fromName, to: A, commit, at }`, `commit` = b64u(sha256(`fleet-view link v1 commit` ‖ epkR ‖ nR)), nR 16 random bytes |
| `link:<pid>:answer` | A | `{ v: 1, pid, from: A, fromName, to: R, epk, at }`, epk A's X25519 public key (b64u) |
| `link:<pid>:reveal` | R, only after it read the answer | `{ v: 1, pid, epk, n, at }`: R's key and nR. A checks them against the commitment |
| `link:<pid>:ok-r`, `ok-a` | that side | `{ v: 1, pid, at }`: Henry confirmed the code there |
| `link:<pid>:done-r`, `done-a` | that side | `{ v: 1, pid, at }`: that side keeps the link now |
| `link:<pid>:no` | either | `{ v: 1, pid, by: 'r' \| 'a', why: 'declined' \| 'mismatch' \| 'expired' \| 'restarted', at }` |

1. **Ask.** Henry presses **Link** on R (`POST /link/request { device: A }`). R makes a fresh X25519 key pair and nR,
   and writes the ask. A answers only an ask addressed to it, from a machine the devices table lists, at most 3 at once.
2. **Answer.** A makes its own key pair and writes the answer. Its Sync card opens by itself with the request.
3. **Reveal.** R reads the answer and only then reveals its key and nR. A refuses a reveal that does not match the
   commitment (`no`, `mismatch`): someone may be in the middle, and nothing is linked.
4. **The code.** Both sides derive, from the X25519 shared secret (an all-zero one is refused) and the transcript T,
   which is the length-prefixed `fleet-view link v1`, pid, R, A, commit, epkA, epkR and nR:
   `salt = sha256(T)`, then HKDF-SHA256(shared, salt, info `fleet-view link v1 <x>`) for x in
   - `key r-a`, `key a-r`: 32 bytes each, R's calls to A and A's calls to R;
   - `dev r-a`, `dev a-r`: 12 bytes each (b64u), the relay device ids of those two;
   - `code`: 4 bytes, read as a big-endian number mod 1,000,000, six digits.

   R shows the code once it has the answer, A once it has checked the reveal.
5. **Confirm on both.** Henry compares the codes and presses **The codes match** on each machine
   (`POST /link/confirm { pid }`, which writes `ok-<side>`). Each machine will run what the other sends, so a side keeps
   the link only when it has its own confirm and sees the other's. Then:
   - its relay keeps the other machine: `relay.addComputer({ dev: the incoming id, name, peer, key: the incoming key })`,
     a paired device of kind `computer` in `devices.json` (no key) and `relay-keys`;
   - its link keeps the outgoing id and key: `<dataDir>/link/peers.json` `{ v: 1, peers: [{ peer, name, dev, pairedAt }] }`
     (no key), and the keys in `protectedStore(<dataDir>/link, 'link-keys')` (DPAPI, the Keychain or a 0600 file) as
     `{ <peer>: { dev, k } }`;
   - it writes `done-<side>`. A newer link with the same machine replaces the older one.

**Why a man in the middle fails.** To show both machines one code, he must commit to the key he reveals to A before A's
key is known, and pick the key he answers R with before R's key is known. Each code is then a fresh random number to
him: they match one time in a million, and Henry sees two different codes otherwise.

**Who deletes the rows.** The side that reads the other's `no` (after it took back a link it kept), R once it read
`done-a`, and A when its own pairing ran out. A side that says `no` leaves the rows for the other to read. So a link kept
on one side is never left there alone: the other side keeps it too or says no. Rows of a pairing nobody finished are
deleted 10 minutes after it ended.

**Running out and restarts.** A pairing runs out 10 minutes after it began on each side's own clock (never compared with
the other machine's). R then says `no` (`expired`), A drops what it has. The private keys live in memory only: an ask
this machine answered (or made) before it restarted is answered `no` (`restarted`). **Decline** (`POST /link/decline
{ pid }`) on either side says `no` (`declined`).

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

- its relay revokes the other machine (`removeComputer`: the notice `revoked`, then the key is gone), and its link forgets
  its key;
- the other machine's link hears `revoked` on its channel and unlinks too, at once;
- for a machine that is off, it also writes `link-gone:<to>:<from>` `{ v: 1, from, to, devs, at }`. The other machine
  unlinks when it reads it (only a link whose ids are in `devs`, so an older row never takes a newer link away) and
  deletes it. Keeping a new link deletes the gone rows between the two machines.

`node relay.js revoke <dev>` on a computer's device unlinks both too (fleet-view.js `onComputerGone`).

## Routes and the page

`/link/*` serve this machine's own page only: never a remote browser or another site's page, POSTs with its Origin.
While sync is not set up here (a friend's install) they answer 404, as `/sync/*` do, and the link runs only while sync
does (`sync-run.js`: set up, signed in, the key here), beside the mover, whose device id it uses.

| Route | Does |
|---|---|
| `GET /link/status` | `{ running, me, machines: [{ id, name, platform, lastSeenAt, linked, online, pairedAt, version }], pairings: [{ pid, role, peer, state, code?, confirmedHere, message?, at }] }`, or `{ running: false, reason }` |
| `POST /link/request { device }` | ask that machine to link: `{ ok, pid }` |
| `POST /link/confirm { pid }` | the code here matches the other machine's |
| `POST /link/decline { pid }` | no |
| `POST /link/unlink { device }` | unlink it, here and there |

A pairing's state: `asking` (R waits for the answer), `waiting` (A waits for the reveal), `confirm` (the code is shown),
`confirmed` (Henry confirmed here, waiting for the other machine), then `linked`, `declined`, `failed`, `expired` or
`cancelled`.

The Sync card (`web/sync.js`) lists the other machines under **Your machines**: linked (online or offline) or not,
**Link**, the code with **The codes match** and **Decline**, and **Unlink** after a second click. While the card is
closed it reads `GET /link/status` every 5 seconds, so a request from another machine opens it once and marks the
header's sync button. The phone card (`web/phone.js`) leaves computers out of its list.

### The Chat tab's routes (typing into a chat the other machine runs)

`link-send.js` (docs/sync-follow.md item 6, "Follow you"). For a chat another machine runs (sync-run.js `owners()`),
the Chat tab sends, answers, stops and reads it through these, and each goes to that machine's own route through the
link (`call()`), so its relay checks it and marks it as Henry's like the phone's. Only the fields listed go on.

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
here), `not_linked` 409 ("Link <host> in the Sync card to type here"), `revoked` 409, `pc-restarted` 409, `too_large`
413, `bad_answer` 502, `offline` 503, `stopped` 503, `timeout` 504.

`GET /conversation?id=` for such a chat is read on the host through the link while the link to it is up (online), and
says `source: '<host's name>'`; otherwise this machine's synced copy answers with `source: 'local'`. Only this
machine's page goes on to the host (`Sec-Fetch-Site: same-origin`, which the relay never sends), so a phone's read
never chains to a third machine. The feed (`web/chat.js`) loads the list again from the start when `source` changes.

Tests: `node scripts/link-send-test.js` (the routes, with a fake link and owner list) and `node
scripts/follow-plan-test.mjs` (what the Chat tab's Send does).

## Off

With sync off there is no link: no socket, no timer and no key read. With sync on and nothing linked, the link reads
its rows every 5 s and opens no socket. The link's keys are read only while `peers.json` lists a machine.

## Tests

`node scripts/link-test.js` (about a second, no network): two machines, each with a real relay.js and link, over a fake
Supabase (the tables, and a Realtime hub with presence), with a fake Fleet View server each. It covers pairing end to end
(the same code on both, nothing kept until both confirmed, the keys agreeing across the two machines, the rows deleted),
calls both ways (`/peer/status` with the marker and the peer header, a message with the marker, parts down and up, a
429, a lost answer asked again with the same id and run once), a phone refused the `/peer/` routes, presence, a man in
the middle (two different codes; a reveal that does not match its commitment refused), decline, running out, unlink at
once and through the gone row, and linking again. `node scripts/relay-test.js` still checks the relay for phones.
