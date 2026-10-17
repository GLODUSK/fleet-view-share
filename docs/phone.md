# Fleet View for iPhone: the relay protocol (v2)

The phone app (`phone/`, Expo) shows Cards, Wall and Projects (Projects as a Claude-app-style chat list with the
Chats tab's bots and team group chats). It never calls the server's routes itself: the PC's **relay**
(`relay.js`, inside the Fleet View server) opens each encrypted envelope, checks it, and answers the phone by calling
the server's own routes over loopback. The envelopes travel through **Sync with Blackbox** (mode `relay`): both
sides join a private **Supabase Realtime Broadcast** channel. Works from anywhere. Nothing is stored in the database:
Supabase only carries encrypted envelopes. There is no open port and no Tailscale.

(A second way, **Work locally** (mode `local`: a WebSocket straight to the PC on the same Wi-Fi, `relay-lan.js` on
port 4779), was taken out on 2026-10-14. The PC refuses a pairing asking for it, drops a device paired that way at
start, key and all, and the phone refuses a Wi-Fi code and drops a Wi-Fi pairing an older app kept: that phone pairs
again through Blackbox.)

This file is the contract between `relay.js` and the app. `docs/phone-vectors.json` holds fixed inputs and the exact
outputs of the crypto below. It is made by `node scripts/phone-vectors.js` with node's own crypto, and both sides
test against it.

Protocol v2 (this one) differs from v1 in one place: the key in the QR code only pairs. The first hello makes the
device's own key with an X25519 exchange, and from then on the QR code opens nothing. A v1 pairing is not read by a
v2 relay: that phone pairs again. Nothing was paired for real under v1.

## The three locks

1. **Supabase sign-in.** The PC is signed in through sync S1 (`sync-api.js`), and the phone signs in with the same
   Google account. The channel is private. Migration `0376_fleet_sync_relay.sql` (detailforge-web) lets a signed-in
   user read and send only on topics `fleet:<their own user id>:*`, and only while `fleet_sync.is_member()` is true.
   Anyone holding the project's `service_role` key (Supabase itself, and whoever runs the project) bypasses those
   policies and can join any `fleet:` topic: the channel keeps strangers out, but what protects the content is the
   encryption below.
2. **A device key.** Pairing makes 32 random bytes `K` on the PC, shown once in a QR code on the PC's screen. `K`
   is good for one thing, the pairing handshake: the phone and the PC each add a fresh X25519 key, and both make the
   device's own key `K'`, which the QR code never held. The PC keeps its keys with S1's
   `protectedStore(<dataDir>/relay, 'relay-keys')` (DPAPI, the Keychain, or a `0600` file), and the phone keeps its
   pairing in SecureStore. Every message is AES-256-GCM, with one key per direction.
3. **An allowlist.** The relay forwards only the method and path pairs listed below, and refuses everything else
   with 403. A message from the phone runs commands on the PC as Henry, so the list stays short, and the routes
   that read files are fenced (see "What the phone may read").

Supabase sees who is connected, when, and how big each message is, but never what is in it.

## Names

| Name | Meaning |
|---|---|
| `uid` | the Supabase user id (a lowercase UUID) of the PC's S1 sign-in |
| `dev` | the device id: 16 characters, base64url of 12 random bytes, made by the PC at pairing |
| `topic` | `fleet:<uid>:<dev>`. On the wire realtime-js sends `realtime:fleet:<uid>:<dev>`, and `realtime.topic()` in the policies returns it without `realtime:` |
| `K` | the pairing key: 32 random bytes in the QR code, for the handshake only |
| `K'` | the device's own key, made by the handshake; every message after it goes under `K'` |
| b64u | base64url with no padding (RFC 4648 section 5). Envelope fields use it |
| b64 | standard base64 with padding. Binary bodies (`b64`) use it, so they drop straight into a `data:` URL |

## Pairing

1. On the PC, the page's "Pair an iPhone" card calls `POST /relay/pair { name?, mode? }` (`mode` `"relay"`, the
   default and the only one; `"local"` gets 400 "update the app"), or run `node relay.js pair [--name N]`. The relay
   makes `dev` and `K` and keeps the device as `pending` for 10 minutes. It answers with the pairing link and its QR
   code as SVG. `K` is shown only then, and is never logged. It needs sync set up and signed in (409 otherwise).
2. The link is `fleetview://pair?d=<b64u of the UTF-8 JSON>`:

   ```json
   { "v": 2, "url": "https://<project>.supabase.co", "key": "<publishable key>", "uid": "<uid>",
     "email": "<the PC's Google email>", "pcName": "<the PC's name>", "dev": "<dev>", "k": "<b64u of K>",
     "exp": 1760141400000 }
   ```

   `url` and `key` come from S1's `readConfig(dataDir).config` (`{ url, key }`). The publishable key is public, but
   the link is a secret until the phone has paired: anyone who scans it and can also sign in as Henry could pair in
   his place. `pair.html` says so: "It pairs one phone. The phone and this PC then make a key of their own that
   this code does not hold, and the code opens nothing after that."
3. The phone scans the QR code (or opens the link) and refuses it unless `v` is 2, `exp` is in the future, and `url`
   is `https://<ref>.supabase.co`. Then it signs in with Google through Supabase Auth (PKCE, `login_hint` = `email`,
   redirect `fleetview://auth-callback`). If the signed-in user's id is not `uid`, it says "Sign in with <email>,
   the account the PC uses" and signs out. Otherwise it saves `{ url, key, uid, email, pcName, dev, k }` in
   SecureStore (`k` is `K`), joins the channel, and starts the handshake.
   A Wi-Fi code from an older PC (`"mode": "local"`) is refused, saying that way is gone.
4. **The handshake.** While its stored key is `K`, the phone sends nothing but a `hello`, sealed under `K` like any
   envelope, with one more field: `epk`, the b64u of a fresh X25519 public key (its secret stays in memory for this
   one hello). The relay, for a hello under `K` before its time is up:
   - makes its own fresh X25519 key pair and `K' = HKDF-SHA256(ikm = K || X25519(its secret, epk), salt: none,
     info = "fleet-view relay v2 paired", length 32)` (`||` joins the bytes; "none" is HKDF's zero-length salt);
   - **keeps `K'` in its key store before it answers**, next to `K` and the `K'` of any earlier handshake (4 at
     most), and marks the device `paired`;
   - answers under `K`: `res` 200 `{ paired: true, pcName, version, device, platform, epk }` with its own public key.
     `device` is the machine's sync device id (`<dataDir>/sync/device.json`, lower case) while sync is set up there,
     else `null`; `platform` is its `process.platform`. Every hello's 200 carries both (see "Several machines"); an
     older PC sends neither.

   The phone makes the same `K'` from its secret and the PC's `epk`, and **saves `K'` in place of `K` in the one
   SecureStore write that holds the pairing** (`own: true` marks it), before anything goes under `K'`. The first
   thing that does is a `hello` under `K'` (no `epk`), answered 200 `{ paired: true, pcName, version, device, platform }`.
5. **The first envelope under a `K'` finishes the pairing on the PC:** that `K'` becomes the device's key, and `K`
   and every other `K'` are forgotten (deleted from the key store). After that, `K` gets `403 { ok: false, paired:
   false, message: "already paired..." }` (a `hello` or a `req`, for as long as `K` would have opened hellos, and
   only while the relay runs: later, or after a restart, they are dropped silently), the other `K'` open nothing,
   and scanning the QR code again pairs nothing.
6. **The rule for a lost answer (crash-safe on both sides).** Each side switches keys in one write, after the other
   side can no longer be stranded:
   - the PC keeps each `K'` before the answer that carries its half goes, so a phone that got the answer can always
     use its `K'`, whatever the PC did since (a restart included);
   - the phone forgets `K` only in the write that keeps `K'`, so a phone that did not get the answer (or crashed
     before the write) still has `K`, says `hello` under `K` again with a new X25519 key, and gets another `K'`;
   - the PC takes whichever kept `K'` its first envelope comes under. `K` opens hellos until 10 minutes after the
     last one (or `exp`, whichever is later), so a phone that lost an answer has time to try again. The `K'` the
     handshakes made open nothing after that time either.

   **Handshake limits.** Each handshake makes a key pair and writes the key store, so one code makes at most **8**,
   and at most **one every 5 seconds** per device. A hello under `K` sooner gets 429 with `retryAfter` (ms); a 9th
   gets 403 `{ paired: false }` "this pairing code was tried too many times: make a new one on the PC".

   A `hello` without `epk` under `K` gets 400 (an app that pairs the v1 way), and one whose `epk` is not a usable
   X25519 public key (not 32 bytes, or a low-order point whose shared secret is all zeros) gets 400 too. A `req`
   under `K` before the pairing finished gets 403 "not paired yet: send hello first".
7. A device still pending after `exp` (no handshake yet) is dropped, key and all. So is one whose handshake was
   answered but whose first envelope under a `K'` never came before `K`'s time ran out (10 minutes after the last
   handshake), and the relay leaves its channel. A phone whose first hello under its new `K'` goes unanswered says
   "Pairing didn't complete. Make a new code on the PC."
8. **Revoke:** `POST /relay/revoke { id }` or `node relay.js revoke <id>`, The relay sends `notice`
   `revoked`, leaves the channel and deletes the key; a request of that device still being checked is dropped before it reaches
   the server. On that notice the phone wipes its pairing and its cached data. "Unpair" on the phone only forgets
   the pairing on the phone; the PC lists the device until it is revoked.

## Pairing by sign-in

The usual way since 2026-10-13: no QR code. The phone signs in with Google once, lists the computers signed in to
Blackbox sync with the same account, and pairs the one Henry taps.
The QR code stays behind "Use a pairing code instead".

- **The lobby.** Every machine whose sync is signed in joins `fleet:<uid>:lobby` (relay-lobby.js). 0376's policies
  already confine `fleet:<uid>:*` to that account while it is a sync member, so no migration was needed. A machine
  whose sync is not signed in is not listed.
- **Presence.** Key `pc-<id>`; `id` is 16 b64u, made once and kept in `<dataDir>/relay/lobby.json`. Payload
  `{ role: 'pc', v: 1, id, name, device, platform, version, at }`, sent again every 5 minutes (an older PC's also has
  `hosts`, its Wi-Fi addresses, which the phone ignores). The phone joins with key `phone-<random>`.
- **Ask** (phone, broadcast event `e`): `{ t: 'pair-ask', v: 1, to: <id>, rid, epk, mode: 'relay', name,
  phone, at }` (an older app's `mode: 'local'` is answered `pair-no`, "update the app"). `rid` is 16-32 b64u, new
  for each pairing; `epk` is a fresh X25519 public key; `phone` is the install id (AsyncStorage `fv.phoneId`). The phone sends the same ask every 3 s, and gives up after 25 s.
- **Answer** (machine): it makes a pairing with relay.js `pair(name, mode, { phone, via: 'sign-in' })`, the same
  pending device, `K` and handshake as a QR code's, after dropping that phone's older devices. It sends
  `{ t: 'pair-link', v: 1, rid, from: <id>, epk, n, c }`, where `c` is the link text sealed with AES-256-GCM (tag
  after the ciphertext). The key is HKDF-SHA256 of X25519(the machine's one-time secret, the ask's `epk`), salt the
  UTF-8 `rid`, info `fleet-view lobby v1`; AAD `fleet-view lobby v1|<topic>|<rid>|<id>`. Supabase never carries `K`
  in the clear. A refusal is `{ t: 'pair-no', v: 1, rid, from, message }`.
- **Limits.** The same `rid` gets the same answer for 10 minutes; at most 12 asks a minute; an ask whose `at` is more
  than 5 minutes off is ignored.
- **The phone** opens the box (phone/src/crypto/lobby.ts), checks the link as a scanned one, and refuses a link for
  another account, or a Wi-Fi link from an older PC. The pairing keeps the machine's lobby id (`lobby`).
- **Trust is the account.** Anyone who can sign in as Henry's sync account can pair a phone, and the machine pairs
  without a click on its screen (Henry's call).
- **Afterwards.** The Google sign-in survives Unpair. When a machine stops taking a pairing that has a lobby id and is
  in the lobby, the phone pairs it again by itself; a revocation is never undone.

## The channel

- Both sides join `topic` with `{ private: true, broadcast: { self: false, ack: false }, presence: { key } }`,
  with key `"pc"` or `"phone"`, using their own Supabase access token. The PC sends its new token on every refresh
  (the `access_token` message), and it leaves and joins again when S1 says `signed-in` or `signed-out`
  (`onChange`). S1's config is read again on every (re)connect, never cached.
- **Presence:** the PC tracks `{ role: "pc", v: 1, at }` under key `pc`. The phone shows "PC online" while that key
  is present and "PC offline since <time>" when it is not. The phone tracks `{ role: "phone", v: 1, at }`, and the
  PC only uses it for the device's `lastSeen`.
- Every message is one broadcast, event `"e"`, whose payload is the envelope.

## The envelope

```json
{ "v": 1, "d": "<dev>", "dir": "up", "n": "<b64u 12-byte nonce>", "z": 0, "c": "<b64u ciphertext then 16-byte tag>" }
```

- `dir` is `"up"` from the phone to the PC and `"down"` from the PC to the phone. The envelope's `v` stays 1 in
  protocol v2.
- **Keys:** `K_up = HKDF-SHA256(ikm = key, salt = "fleet-view relay v1", info = "up", length 32)`. `K_down` is the
  same with info `"down"`. Strings are UTF-8. `key` is `K` for the handshake's hello and its answer, and `K'` for
  everything else.
- **AAD:** the UTF-8 bytes of `fleet-view relay v1|<topic>|<d>|<dir>|<z>`, with `z` as the digit `0` or `1`.
- **Nonce:** 12 fresh random bytes for every envelope.
- **Plaintext:** the UTF-8 JSON of one message (below). With `z: 1` the plaintext was compressed with raw DEFLATE
  (RFC 1951, no zlib or gzip header) before encryption. A sender compresses when the JSON is over 1024 bytes, and a
  receiver accepts either.
- **Sizes.** The phone stops inflating past 64 MB. The relay, for what comes up: a ciphertext longer than
  1,601,388 b64u characters (a 400,000-character message at 3 bytes a character, its fields and the tag) is
  dropped before it is decoded, an inflate stops at 2 MB, and at most 4 envelopes per device inflate at once, with
  32 more waiting; the rest are dropped.
- **Supabase's limit.** Realtime takes a Broadcast message of at most 256 KB on the Free plan and 3,000 KB on Pro
  and above (supabase.com/docs/guides/realtime/quotas, "Broadcast payload size"; read 2026-10-11). The largest
  envelope either side sends is one part of 400,000 characters: at most 1.2 MB of UTF-8, about 1.6 MB as b64u, with
  the frame around it. The sync project is on GLODUSK's Pro plan, so that fits with about 1.4 MB to spare, and the
  part size stays 400,000. On a Free-plan project a big part would not get through (Realtime refuses it; the other
  side never sees it): parts would have to be at most about 60,000 characters (4 bytes of b64u a character at worst)
  on both sides, with more of them allowed.
- A receiver silently drops (and counts) any envelope with the wrong `v`, `d` or `dir`, bad base64, a failed
  decryption, a failed inflate, or JSON that does not parse. It never answers a message it could not decrypt.

## Messages

Every message has `t` (its type), `id` and `at`. `at` is the sender's clock in ms. `id` is 1 to 32 characters of
`[A-Za-z0-9_-]`; the phone makes 16 random bytes in b64u.

**From the phone (up):**

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `app` (its version), `device` (the phone's name), `epk` (only under `K`: the handshake) | under `K`: the handshake; under `K'`: the phone is here (the first one finishes the pairing) |
| `req` | `m` (`"GET"` or `"POST"`), `p` (the path), `q?` (query: `{ name: string \| number \| boolean }`), `b?` (the JSON body of a POST), `etag?`, `t0` (the first attempt's time) | one request to the server |
| `part` | see Parts | |

**From the PC (down):**

| `t` | Fields | Meaning |
|---|---|---|
| `res` | `s` (the HTTP status), `b?`, `b64?`, `ct?`, `etag?` | the answer to the `req` or `hello` with the same `id` |
| `notice` | `kind`: `"revoked"` or `"pc-closing"` | the device was revoked; the server is shutting down |
| `part` | see Parts | |

- **Bodies:** a JSON answer comes as `b` (parsed). A `text/*` answer comes as `b` (a string) with `ct`. Anything
  else, such as an image from `/conversation/image`, comes as `b64` with `ct`.
- **ETags:** the relay sends `etag` as `If-None-Match` and returns the answer's `ETag` as `etag`. `GET /state` already
  answers 304 when nothing changed. Then `res` has `s: 304` and no body, and the phone keeps what it has.
- **Errors the relay makes itself** have `b: { ok: false, message }`: 400 a bad request, 403 not on the allowlist (or
  a refused settings key, root or path), 408 the server took too long, 409 a POST it may have run already (below),
  413 too large, 429 too many (`b.retryAfter` in ms), 502 the server did not answer.
- **The answers the phone's UI reads (a contract):** a 429's `b.retryAfter` is in **milliseconds**, and the 409 for
  a POST that may have run already has `b.restarted === true` (or `b.expired === true`). The phone's transport
  passes both on as they came: the screens get an `ApiError` whose `status` is 429 or 409 and whose `body` is
  that `b`, with `b.message` as its message.

### Replays and retries

- A receiver drops a message whose `at` is more than 5 minutes from its own clock, and any envelope whose nonce it
  has seen in the last 10 minutes on that device and direction. The PC also drops messages with `at` before the
  relay started, so nothing sent before a restart can be replayed after it.
- A `res` is accepted only for an `id` the phone still has in flight. A late or doubled answer is ignored.
- **The `id` is the retry key.** The phone retries a request with the same `id` (a new nonce and `at`, the same
  `t0`). The relay keeps each `id`'s answer for 10 minutes: a repeat gets the kept answer, and a repeat of one still
  running is ignored (its answer comes once). A 429 is not kept, so the same `id` runs once the limits allow.
- **`t0` and a restart.** The relay's kept answers live in memory, so a restart forgets them. A POST sent again
  (`t0` before `at`) whose `id` the relay does not know, and whose first attempt went before the relay started
  (its time on the PC's clock, `now - (at - t0)`, with 2 seconds for the way there), may have run before the
  restart. The relay does not run it: it answers `409 { ok: false, restarted: true, message }`. One whose first
  attempt went 9 minutes ago or more (its kept answer may be gone) gets `409 { ok: false, expired: true }`. Both
  are kept like any answer. Their `message` is the text the phone shows: "The PC restarted while this was being
  sent. Check before sending again." (and for `expired`: "This was first sent too long ago for the PC to tell
  whether it went in. Check before sending again."). The phone never retries them by itself. A first attempt has
  `t0` equal to `at`; a
  `t0` after `at`, or not a number, is 400. A GET runs again in any case. So the relay never runs a POST twice:
  either it still has the `id`'s answer, or it says it can't tell. (It remembers 15,000 ids per device, more than
  the 1,200-a-minute limit lets a phone send in 9 minutes.)
- **`pc-closing` ends what is in flight.** The server sends the notice as it exits (on a restart after an update,
  mostly), and the answers still owed die with it. So the phone fails every request still waiting at once, rather
  than at its timeout, with the code `pc-restarted` and the request's `id`. A POST cut off that way may have gone in
  (the server may have typed the message just before it exited), and the kept answer that would make a resend safe
  is gone: the phone shows it as "may have gone in", never offers Retry, and lets the transcript settle it. A GET is
  a plain no-answer, which the pollers try again. A link that only drops sends no notice, and a resend with the same
  `id` still gets the relay's kept answer.
- **The transcript settles any bubble.** A message the phone sent goes from the chat once the transcript shows its
  text, whatever its state, even one still "Sending..." or "Not sent yet": the answer can be lost while the message
  went in. Only a message the PC answered may also be matched another way (the oldest sent before the transcript
  logged one whose text reads differently).
- **Timeouts.** The relay caps `wait` in an `/api/*` body at 50 seconds, then gives each request this long on the
  server before it answers 408 itself:

  | Route | Relay | With `wait` | The phone waits |
  |---|---|---|---|
  | `POST /api/sessions`, `/api/sessions/:id/fork`, `/api/bots`, `/api/bots/requests/:id/approve`, `/api/bots/:id/start` (they start a Claude: the server waits up to 60 s for it to be ready, settles, then types; `POST /api/bots` makes the bot and starts it; a fork from a message answers once the fork started, and goes back to the message after); the page's `/bots/:id/tasks/:taskId` (Run now starts the bot first when it is not running) and `/bots/:id/watch` (a new watch or job starts the bot first, then tells it) | 95 s | 95 s + the wait | 100 s (+ the wait) |
  | `POST /api/sessions/:id/message` and `/open`; `POST /api/teams`, `/api/teams/:id/add`, `/lead` and `/message`; the page's `/teams`, `/teams/add` and `/teams/lead` (each may resume a stopped conversation first, up to 60 s, before it types) | 75 s | 75 s + the wait | 80 s (+ the wait) |
  | any other `/api/*` POST with `wait` (e.g. `/answer`) | 60 s | | the wait + 15 s |
  | `GET /api/sessions/:id/activity` (the chat's activity line, polled) | 5 s | | 20 s |
  | `POST /api/sessions/:id/now` (send now), `/enter` (Send it), `/background` (Run in background) and `/panel` (a key in a command's panel: Tab to a tab a press at a time, an Esc read back up to 1.5 s) | 10 s | | 20 s |
  | `POST /api/sessions/:id/model` (a model or effort switch: `/model`, `/effort`, the default put back), `/mode` (the permission mode: Shift+Tab, read back after each press), and the page's `/bots/:id/switch` (the same, for a dynamic bot) | 20 s | | 25 s (`/model` and `/bots/:id/switch`: the caller sets `timeoutMs`) |
  | `POST /api/sessions/:id/rewind` (Rewind and Edit: "/rewind", then ↑ a press at a time up its list, each read back; api.js bounds the walk at 40 s) | 60 s | | 65 s |
  | `POST /chat/image` and `/upload` (a picture or a file from the phone: a 15 MB one goes up as 53 parts, 20 a second, before the PC saves it) | 30 s | | 90 s (the caller sets `timeoutMs`) |
  | everything else (`/unsend` among them) | 30 s | | 20 s |

  So 145 s and 125 s at most. The wait added is the one the relay passed on (`true` and anything over 50 count as
  50). After its own time runs out the phone retries a GET once, and for a POST it shows "not sent yet, retry?". A
  retry with the same `id` gets the relay's answer once it has one: answers are kept for 10 minutes from the
  request, nonces are remembered for 10 minutes and `at` is checked only when a message arrives, so none of the
  limits above runs out before the longest route answers. A request that waits holds one of the device's 20
  in-flight places the whole time.

### Parts

A message whose JSON text is longer than 400,000 characters goes as consecutive `part` messages:

```json
{ "t": "part", "id": "<the id of the whole message>", "at": 1760140800000, "part": 0, "parts": 3, "chunk": "<a slice of its JSON text>" }
```

The text is cut into slices of at most 400,000 UTF-16 code units, never between the two halves of a surrogate pair.
Each part is its own envelope (compressed as usual). The receiver joins the chunks in order once all `parts` arrived,
then parses the result as the message. Limits: at most 64 parts, at most 4 messages being put together per device at
once, and a set not complete within 60 seconds is dropped. From the phone, the whole text may be up to 21,000,000
characters (a 15 MB image or file as base64 in `POST /chat/image` or `/upload`), and the phone sends at most 20 parts a second: every part
counts against the relay's per-second limit, and a part over it is dropped, not answered.

### Limits

Per device, on the relay:

- **20 requests in flight.** Over that: 429, `retryAfter` 1000.
- **30 envelopes a second and 1,200 a minute**, counting every envelope that opens: requests, their repeats, parts
  and hellos. Over that, a `req` or `hello` gets 429 with `retryAfter`, and a part is dropped.
- **The routes that start or resume a Claude: 2 at once, and 12 in 10 minutes.** Each counts one (`POST
  /api/sessions`, `/api/sessions/:id/open`, `/api/sessions/:id/fork`, `/api/bots`, `/api/bots/:id/start`, `/api/bots/requests/:id/approve`,
  `/api/teams/:id/add`, the page's `/teams/add`, the page's `/bots/:id/tasks/:taskId` with `action: "run"`, and the page's `/bots/:id/watch` with a `job`), a team one per distinct member (`POST /api/teams`, the page's
  `/teams`; 12 at most), and a lead only when there is one (`/api/teams/:id/lead`, `/teams/lead`). A message counts
  what it may resume, as `/state` says it (read again when over 15 s old): `POST /api/sessions/:id/message` that
  opens one (`open: true`, or a `from` without `open`) counts one unless a claude process has that conversation
  open (`openElsewhere`), and `POST /api/teams/:id/message` one per member not running (one when `/state` lists
  none of its members). Over that: 429, with `retryAfter` 5 s while two are starting, else until the oldest counted
  one is 10 minutes old.
- **64 MB of answers being read from the server at once.** Past that the answer being read is cut off with 429
  (`retryAfter` 2000). One answer is at most 32 MB (413).
- The caps on what comes up are under "The envelope", and the parts' under "Parts".

## What the phone may call (allowlist v2)

`relay.js` holds the list; this table mirrors it. The relay checks the method and the whole path. Session ids, team
ids and bot ids must match their own patterns, and a path with `..`, `//`, `%`, `?`, `#` or a backslash is refused.
Another of Henry's computers, linked through `link.js` ([link.md](link.md)), may call this list too, plus the
`/peer/...` routes of `PEER_ALLOW`, which a phone may never call (403).

**GET:** `/state`, `/conversation`, `/conversation/image`, `/repo-history`, `/chat/commands`, `/chat/files`,
`/chat/kind`, `/file`, `/since`, `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/menu`,
`/api/sessions/:id/transcript` (with `queue`, the messages queued in Claude Code), `/api/sessions/:id/activity`,
`/api/conversations`, `/api/teams`, `/api/status`, `/accounts`, `/api/bots/requests` (the bots sessions asked for; `/state`'s `botRequests` has the same).

**POST:** `/api/sessions`, `/api/sessions/:id/message`, `/api/sessions/:id/answer`, `/api/sessions/:id/interrupt`,
`/api/sessions/:id/open`, `/api/sessions/:id/stop`, `/api/sessions/:id/remove`, `/api/sessions/:id/now`,
`/api/sessions/:id/unsend`, `/api/sessions/:id/model`, `/api/sessions/:id/enter`, `/api/sessions/:id/background`,
`/api/sessions/:id/mode`, `/api/sessions/:id/panel`, `/api/sessions/:id/rewind`, `/api/sessions/:id/fork`, `/api/teams`,
`/api/teams/:id/add`, `/api/teams/:id/remove`, `/api/teams/:id/lead`, `/api/teams/:id/disband`,
`/api/teams/:id/message`, `/api/bots`, `/api/bots/:id`, `/api/bots/:id/start`,
`/api/bots/:id/remove`, `/api/bots/requests/:id/approve`, `/api/bots/requests/:id/decline`, `/settings`, `/rename`, `/sessions/move`, `/push-target`, `/repos/remove`, `/repos/add`,
`/chat/image`, `/upload` (a file from the phone, below), and the page's `/teams` (the phone's New team sends it as the page's New team does: `{ members, order, name,
lead, send: true }`, then `/teams/add` for a team above and `/teams/leave` with `quiet` for a member its order missed),
`/teams/add`, `/teams/remove`, `/teams/leave`, `/teams/lead`, `/teams/rename`, `/bots/:id/switch`, `/bots/:id/map`, `/bots/:id/watch` and `/bots/:id/tasks/:taskId`,
`/chat/dynamic` (Dynamic on or off for any chat, below), and `/accounts/add`, `/accounts/login`,
`/accounts/code` and `/accounts/cancel` (only to sign in a missing Claude A or B, below), and `/push/token` (the
relay's own route, never the server's: "Notifications").

**GET and POST:** `/sync/move` (Continue here, asked of a machine that is on for a chat whose host is off: "Several
machines" below; the phone no longer asks it since 2026-10-17, kept for older builds). **GET:** `/sync/main` (the
main computer). The POST takes only `{ id, force? }` (403 for any other field; 400 when `id` is not a conversation
id or `force` is not true or false), the GET only `?id=<a conversation id>` (400). It reaches fleet-view.js's
`/sync/move` as this machine's own page, as the other page routes do.

The Claude accounts (accounts.js; the phone's "Claude accounts" step after pairing and its Settings row):

- `GET /accounts` is the PC's Accounts list (fleet-view.js, this PC only). The relay passes on only
  `{ list: [{ a, email, signedIn }], jobs: { A?, B?: { status, message, url } } }`: every letter here with who it is
  signed in as, and the sign-ins of A and B (`status` `waiting`, `done`, `same` or `failed`; `url`, the claude.ai
  link, only while one waits). accounts.js's `org`, `sameAs` and a job's `email` stay on the PC.
- A sign-in goes as on the PC's start screen: `POST /accounts/add { letter }` for a letter with no folder yet, or
  `POST /accounts/login { account }` for one that has a folder but no login. The PC starts `claude auth login`,
  whose claude.ai link shows up in `GET /accounts` a moment later; the phone opens it, Henry signs in, and the code
  claude.ai shows goes back by `POST /accounts/code { account, code }`. `POST /accounts/cancel { account }` stops it.
- Narrower than the route (which sees this PC's own page): each takes only that body (403 otherwise), only the
  letter `A` or `B` (the letters a synced conversation knows, sync-accounts.js `SYNC_LETTERS`; 403 for any other,
  lower case goes on as upper case), and only while that letter has no login, as `GET /accounts` says at that moment
  (403 "signed in already"; 503 when the list can't be read). `code` must be text of at most 600 characters (400;
  accounts.js checks the rest). So from the phone a signed-in account is never signed in again, switched, relabeled
  or removed, no other letter is added, and no email is chosen; `/accounts/remove` and every other `/accounts/*` stay
  off.

The bots:

- A bot's session starts only by its own route: `POST /api/sessions` with a `role` in its body (any value) is 403.
  (The Chief's `GET /chief/briefing` and `POST /api/chief/start` went with it on 2026-10-13: 403.)
- **Bots** (bots.js, api.js): `POST /api/bots { name, brief?, role?, account?, model?, effort?, shape?, color? }` makes a
  bot and starts it, `POST /api/bots/:id { name?, brief?, role?, account?, model?, effort?, shape?, color? }` changes one
  (the phone's Edit bot sends only what changed), `POST /api/bots/:id/start` starts one, `POST /api/bots/:id/remove`
  takes one off the list. `model` and `effort` may each be `"dynamic"` (a new bot's default: each message is sized
  for it); `role` is what the bot does (one line, at most 60 characters, `""` for none; in its CLAUDE.md and next to its
  name in team briefs; `/state`'s `bots[].role`); `shape` is one of web/mascot.js `SHAPES` and `color` a `#rrggbb`,
  `null` for the automatic pick. A bot id is 12 lowercase hex digits (bots.js `BOT_ID_RE`). api.js takes changing
  and removing a bot only from Henry, which from the phone means the relay's marker (below); making one from Henry
  or from a session on the PC (no relay header; `/state`'s `bots[]` then carry `bySession`, `madeBy`, `madeByName`);
  starting one is open to any caller, so `/start` is not marked. A message for a bot goes through `POST /api/sessions/:id/message` to its conversation (`convId` in
  `/state`'s `bots`), as for any session. `POST /api/bots/look` (a bot changing its own look) is the bot's alone,
  never the phone's.
- **A bot a session asked for** (bots.js `requestBot`): a session unsure Henry wants a bot asks (`POST
  /api/bots/requests`, `fv bot request`; never through the relay: 403). `/state`'s `botRequests` (always there, `[]`
  when none; `GET /api/bots/requests` has the same) lists the ones waiting, newest first: `{ id (12 hex), name, role,
  brief, account, model, effort, why, from, fromName, at }`. `POST /api/bots/requests/:id/approve {}` (**Make it**)
  makes and starts it as `POST /api/bots` does and answers the same (`{ ok, bot, key, id }`; made but not started: `ok`
  false with `bot`, and the request goes all the same; refused: its error, and the request stays), `POST
  /api/bots/requests/:id/decline {}` drops it (`{ ok }`); an unknown id is 404. Both are Henry's alone, so marked. A
  new request pushes (Notifications). A request nobody answered goes after 7 days.
- **A dynamic bot's switch** (bots.js `switchTo`): before a message to a bot whose model or effort is `"dynamic"`,
  the phone sizes the message from its words (web/chats-model.js `sizeTask`) and, when that differs from what its
  session runs now, asks the PC to switch first: the page's `POST /bots/:id/switch { id, model?, effort? }`, `id` its
  conversation. It is a page route, so it goes with this PC's Origin (fleet-view.js lets only the page switch a bot)
  and is not marked.
- **Dynamic for any chat** (fleet-view.js `setDynamicChat`, settings.dynamicChats): `/state`'s sessions carry
  `dynamic: { model, effort } | null` (true: that part is sized per message). The phone's model sheet turns a part on
  or off with the page's `POST /chat/dynamic { id, model?, effort? }` (`true` or `false`; a fixed pick for a dynamic
  part turns it off first), answered `{ ok, dynamic }`; a bot's goes by `POST /api/bots/:id` as before. Before a
  message to such a chat the phone sizes it as for a bot and switches with `POST /api/sessions/:id/model` (the 200k
  models; a bot's the 1M ones by `/bots/:id/switch`). The send waits 8 s at most for that switch, then goes anyway and
  says it was not switched (it may still land). Not offered for a chat another machine runs (`workspace.host`): Dynamic
  sizes what is sent from here. A page route: this PC's Origin, not marked.
- **A bot's tasks and routines** (bots.js, bot-tasks.js): `/state`'s `bots[].tasks` lists each bot's tasks.json
  (`tasksError` when it can't be read), and the page's `POST /bots/:id/tasks/:taskId { action }` acts on one:
  `pause`, `resume`, `run` (send it to the bot now, started first if it is not running) or `delete`. A task id is
  1 to 64 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. A page route too: this PC's Origin, not marked.
- **A bot watching conversations** (bots.js `setWatch`, `setMap`; the page's map mascot menu and a conversation's "Have a
  bot watch it"): `/state`'s `bots[]` carry `map` (its spot on the PC's map, or null) and `watches` (`[{ id, job, since,
  name, last }]`, at most 8 a bot). The page's `POST /bots/:id/watch { id, job }` watches a conversation with a job
  (`report`: tell me when it needs me, `answer`: answer its questions, `review`: review its work when it's done) or
  changes it, and `job: null` stops it; a new watch or job starts the bot first, then tells it (the answer is ok even
  when it could not be told, and says so). `POST /bots/:id/map { at: null }` takes a bot off the map and stops all its
  watches. The phone has no map, so it never puts one there. On the Bots tab a bot's long-press has Watch a
  conversation (a sheet: each conversation ▸ the three jobs, the current one ticked; off when no conversation can be
  watched, or for another machine's bot), Watching (n) (each watch ▸ the jobs and Stop watching) and, only while it
  is on the map, Take off the map (asked first when its watches stop too). A conversation's menu (the Cards and
  Projects tabs, and a conversation row's) has Have a bot watch it ▸ each own bot ▸ the jobs (Stop watching where it
  watches it already): a bot that watches 8 is off ("watches 8 already"), and the item is off with the reason for a
  conversation no bot can watch (not started yet, removed). A watch answers in the PC's own words. Page routes: this
  PC's Origin, not marked.

Narrower rules:

- `POST /settings` may set only `repo`, `repos`, `hidden`, `hiddenRepos`, `finishedOpen`, the list features'
  `repoNames`, `repoOrder` and `forgotten`, and the Bots list's order `chatOrder` (`{ pinned, keys }`: row
  keys `bot:<id>`, `team:<id>`; the server cleans it, dropping any other). Any other key makes the whole request 403. `repo` and each
  `repos` entry that is a path (a bare name only filters by name), and each `hiddenRepos` root, must be a root Fleet
  View already knows (`/state`'s repos, its removed workspaces, its added repos); each `repoNames` and `repoOrder`
  root may also be one the list features' settings already hold. The Chats window keys (`chatsBounds`,
  `chatsOpen`, `chatsOnTop`) stay off: they are desktop state.
- `POST /api/bots` and `POST /api/bots/:id` take only `name`, `brief`, `role`, `account`, `model`, `effort`, `shape` and
  `color` (what bots.js reads; it checks the values itself); any other key, `folder` included, makes the request
  403. `POST /api/bots/:id/start` and `/remove` take no fields at all (403 otherwise), and so do
  `/api/bots/requests/:id/approve` and `/decline`.
- `POST /bots/:id/switch` takes only `id`, `model` and `effort` (403 otherwise): `id` a conversation id, and at
  least one of `model` (a name api.js `MODEL_RE` takes) and `effort` (`low` to `max`), else 400.
  `POST /bots/:id/tasks/:taskId` takes only `action` (403 otherwise), one of `pause`, `resume`, `run`, `delete`
  (400 otherwise). `POST /bots/:id/map` takes only `at` (403 otherwise): null, or `{ x, y }` finite numbers and
  nothing else (400). `POST /bots/:id/watch` takes only `id` and `job` (403 otherwise): `id` a conversation id, `job`
  one of `report`, `answer`, `review`, or null (400). The page's other bot routes (`/bots`, `/bots/:id`, `/start`, `/remove`) stay off: the phone uses
  the `/api/bots` ones.
- **The chat's verbs** (api.js): `POST /api/sessions/:id/now` (the page's Interrupt on a queued message: Claude
  takes what is queued now) takes no fields (403 otherwise) and counts toward no start limit.
  `POST /api/sessions/:id/unsend { text }` takes only `text` (403 otherwise), which must be text as api.js
  `cleanText` takes it: something besides spaces, no control characters but new lines and tabs (400).
  `POST /api/sessions/:id/model { model?, effort?, queue? }` takes only those three (403 otherwise), at least one of
  `model` and `effort`, `model` a name api.js `MODEL_RE` takes, `effort` one of `low`, `medium`, `high`, `xhigh`,
  `max`, and `queue` true or false (400); it is marked, because api.js switches an overseer's model only for Henry (on
  any other conversation the marker changes nothing). The phone sends `queue: true` for a pick made while Claude
  works: api.js answers 202 `{ ok, queued: true, model?, effort?, message }` and makes it once Claude is idle, and
  `/state`'s session says `switchPending: { model?, effort?, at, error? }` until then (the phone shows "after this
  step"; an `error` once).
  `POST /api/sessions/:id/message` may carry `now` (send it at once, stopping the step Claude is on) and `shell` (bash
  mode, below), each true or false (400). `GET /api/sessions/:id/activity` takes nothing; besides the activity line it
  says `mode` (the permission mode its footer shows: `default`, `acceptEdits`, `plan`, `auto`, `bypass`, or null),
  `bg` (a shell command runs that Ctrl+B can send to the background), `prompt` (the prompt box's text, a bash-mode
  one as `!<command>`, null when it is not on screen), `rewind` (the last Rewind or Edit, below, or null), `fork` (on a
  fork from a message, how its going back goes, below, or null) and `panel` (a command's panel up, below, or null). The
  phone reads it every 1.5 s while Claude works, a message it sent may still be in the prompt or a panel is up (and
  while a "/" command that opens one is on its way), every 5 s while the session runs idle.
  - **Send it** (the page's `fv-chat-stuck`): `POST /api/sessions/:id/enter { text }` takes only `text` (403
    otherwise), text as for `/unsend` (400). api.js presses Enter once more only while the prompt box holds exactly that
    text (spaces and `\` aside; a bash command as `!<command>`) and no menu or panel is up; 409 `{ gone: true }` when it
    is not there any more. The phone offers it on a message the PC typed whose text `/activity`'s `prompt` still shows
    2.5 s later ("Not sent: it is still in Claude's prompt"). A message with pictures reads differently in the box (its
    paths became `[Image #N]`), so it is never offered there.
  - **Run in background** (the page's Ctrl+B): `POST /api/sessions/:id/background` takes no fields (403 otherwise);
    api.js presses Ctrl+B only while Claude works, its screen offers it ("ctrl+b to run in background") and no menu or
    panel is up (409). The phone's activity line shows the button while `/activity` says `bg`.
  - **The permission mode** (the page's mode menu): `POST /api/sessions/:id/mode { mode }` takes only `mode` (403
    otherwise), one of `default`, `acceptEdits`, `plan`, `auto`, `bypass` (400). api.js presses Shift+Tab until the
    footer shows that mode (at most 5 presses, stopping once round to where it began: 409 with the `mode` it is on, for
    a mode the session lacks), only while Claude is idle with no menu or panel up (409), from a mode it can read. It is
    marked: an overseer's mode is Henry's alone, as its model. A project chat's composer has the mode button next to the
    model's; a bot's box stays plain.
  - **A command's panel** (the page's panel card: `/usage`, `/status`, `/config`, `/mcp`, `/help`, `/permissions`,
    `/theme`, `/resume`...). `/activity`'s `panel` is the panel on its screen as the page's card reads it (screen.js
    `panelShown`, a port of compose.js `parsePanel`; api.js `panelFrom`): `{ title, tabs: [{ label, on }], body:
    [lines], keys, sig, cmd }`, `keys` its keys line ("↑/↓ to navigate · Enter to confirm · Esc to cancel"), `sig` 12
    hex that change with any of it, `cmd` the "/" command that opened it (the host's `slashPanel`) or null; a question
    up instead is the menu's (a panel a "/" command opened is that command's, whatever list it shows). `waiting` says
    `panel` then. `POST /api/sessions/:id/panel { key } | { tab }` takes only one of the two (403 for any other field,
    400 for both or neither): `key` one of `up`, `down`, `left`, `right`, `tab`, `enter`, `esc` (400), pressed once, as
    the page's keycaps press it; `tab` a whole number from 0 to 19 (400), which of the panel's tabs: api.js presses Tab
    until it is on, from the one on now (409 past its tabs, or when it has none). Only while a panel is on its screen
    (409 otherwise, with `menu` when a question is up instead), so an Esc never reaches Claude mid-turn and an Enter
    never answers a menu. 200 `{ panel }`: as it reads a moment after, null once it closed (an Esc looks up to 1.5 s for
    that). It is marked: an overseer's panel is Henry's alone, as its mode (`/permissions` and `/config` change it). Not
    a start. The phone shows it as a card over the box (a question's card comes first): the title (and the command when
    it differs), the tabs as pills (a tap goes to that tab), the lines (in monospace; `/usage`'s bars in cyan, the row
    the ❯ is on in white), the keycaps the page offers (↑ ↓ ← →, Tab when it has tabs, Enter, Esc) and an x (Esc), with
    the keys line under them; each key's answer shows at once. A "/" command that opens a panel, sent from the phone's
    box, brings its card up as soon as the PC typed it; one typed on the PC shows too.
  - **Bash mode**: `POST /api/sessions/:id/message { text, shell: true }` runs `text` (its leading `!` dropped) as a
    shell command: api.js types `!` as a key of its own into the empty prompt, waits for the box to draw bash mode (its
    `!` prefix), then pastes the command and presses Enter. 409 when the prompt holds anything, a menu is up, or Claude
    Code took the `!` as text (taken back with a Backspace); never queued behind a menu, not with `from` or `now` (400);
    in an overseer's session only Henry's (marked, 403 otherwise). The phone sends it for a message that starts with `!`
    (a "! bash" tag over the box; a tap on it sends the text as a plain message instead), shown as `!<command>` as the
    transcript's `<bash-input>` reads.
  - **Rewind and Edit** (the page's, on one of your messages): `POST /api/sessions/:id/rewind { text, nth?, edit? }`
    takes only those three (403 otherwise): `text` and `edit` text as for `/unsend`, `nth` a whole number from 0 (400).
    api.js drives Claude Code's own `/rewind` through the host: it types `/rewind` and Enter, presses ↑ up its list
    (newest at the bottom), reading the screen after each press, until the ❯ is on the `nth` entry from the newest that
    shows `text`'s first line, then Enter. Only while Claude is idle with no menu or panel up and nothing typed in its
    prompt (409 says which); a message not in the list (or not that many times), a list that never opened or closed,
    or a walk over 40 s gets one Esc (or `/rewind` cleared from the prompt) and 409. 200 `{ menu, at }`: Claude Code's
    question of what to restore (the conversation, the code, both, or Never mind) is up and is the caller's to answer
    (`/answer`, as the page's menu card does; never picked by api.js). Once answered, api.js clears what the restore put
    back in Claude Code's prompt and, with `edit`, sends that in its place (as `/message` would); `/activity`'s
    `rewind { state, text, edit, message, at }` says how it ended: `sent`, `restored` (the phone puts the old message
    in its box), `kept` (the conversation stayed as it was: an edit comes back to the box), `failed`. It is marked:
    an overseer's conversation is Henry's alone to rewind. The phone offers Edit and Rewind to here (asked first) on its
    long-press menu for this conversation's own messages, off with the reason while the PC can't be reached, the chat
    is not running there, Claude works or a question is up; Edit opens the composer on the message with an "Editing
    your message" bar and its x.
  - **Fork from here** (the page's Fork on one of your messages, web/forkat.js): `POST /api/sessions/:id/fork { text,
    nth? }` takes only those two (403 otherwise), as `/rewind`'s (400). api.js starts a fork of the conversation (`claude
    --resume <id> --fork-session`, the host's create, in its folder under its account; it need not be running, and its
    state does not matter) and answers 200 `{ key, forkFrom, at }` as soon as the host started it. Then, in the
    background: once the fork is up (its prompt empty and nothing running for 1.5 s, no menu or panel; a trust question
    waits for a person, given up on after 3 minutes), Rewind's walk up its `/rewind` list to the message, and on Claude
    Code's question "Restore conversation" only, picked by api.js (never the code: the fork works in the original's
    folder, so restoring code would undo the original's edits too). What the restore puts back in the fork's prompt is
    cleared there. The fork's `/activity` says how it goes, read on its key (followed by its pty's pid through the
    host's re-keys): `fork { state: working | done | failed, text, from, message, at }`, for 10 minutes after it ended;
    failed keeps the whole conversation. It is marked: an overseer's conversation is Henry's alone to fork, and the fork
    does not take its role. It counts one start. The phone offers Fork from here on its long-press menu for this
    conversation's own messages (not in a bot's chat), off with the reason while the PC can't be reached or the chat
    can't be forked from the phone (no folder or account known), and opens the fork's key as a new chat, pinned to the
    machine that forked it: "Going back to just before your message..." while it goes, then the message in its box to
    change and send, or why it could not go back. Claude Code may not say a fork's own id until it writes (until then it
    goes by its key, or by the original's id when the original was not running, never taken for the fork's): the chat
    waits on the key, with the message in a box there once it went back, and opens once the PC has the id.
- `POST /chat/dynamic` takes only `id` (a conversation id), `model` and `effort` (403 otherwise), at least one of the
  two, each `true` or `false` (400).
- **Files from the phone** (files.js `upload`, the page's browser upload: web/pcfiles.js): `POST /upload?name=<its name>
  { data }` takes only the query's `name` and the body's `data` (403 otherwise). `name` must be a plain file name: at
  most 200 characters, no `/` or `\`, no control character, no `..` (400; files.js `cleanName` makes it safe for Windows
  after). `data` is the file in standard base64 with its padding (400), at most 15 MB of bytes (413: what one message
  from the phone holds as base64, under files.js's own 200 MB). The relay decodes it and sends the bytes on as the
  raw body (`Content-Type: application/octet-stream`) with this PC's Origin, as the page's upload does; files.js
  saves it only as `<dataDir>/uploads/<yyyy-mm-dd>/<8 hex>-<name>` (kept a week) and answers
  `{ ok, path, name, size }`. Not marked. The phone's composer offers **File from the phone** (the Files app through expo-document-picker,
  one or more; a binary without its native half, the store app up to 0.4.0, shows it off with "comes with the next app
  update") and **File or folder on the PC** (the file viewer opened on the chat's folder, `GET /file` behind the
  fence below: Attach takes the folder listed or the file opened, by its path, with nothing sent up). A file over 15
  MB is refused on the phone with its size. Each is a chip over the box (its name, its size or "on the PC", a spinner
  while it goes up, why it did not and a tap to retry), and its path on the PC goes after the text when the message
  is sent, as a picture's does. iOS's picker can't pick a folder from the phone.
- `POST /repos/add` takes only a root Fleet View already knows (in `/state`'s repos or the removed list). The
  same goes for the roots of `/sessions/move`, `/push-target` and `/repo-history`.
- `GET /file`, `/chat/kind`, `/chat/files` and `/chat/commands`' folder are fenced: see the next section.
- `GET /conversation/image` serves only a known conversation's pictures; `POST /api/sessions` checks its repo and
  `forkFrom`, and the page's `/teams` routes take conversation ids.
- Everything else is refused, including `/reveal`, `/open`, `/update/*`, `/sync/*`, every other `/accounts/*` (`/accounts/remove` among them), `/remote*`,
  `/preview/*`, `/housekeeping/*`, `/folders`, `/relay/*`, `/api/ask*` and `/api/sessions/:id/wait`.

### What the phone may read (the fence)

The server's `/file` (files.js) serves anything inside a folder Fleet View knows, and that includes the folder every
conversation ran in, which may be the home folder or a drive's top. So the relay keeps one fence of its own for
`GET /file` (its `path`, with `cwd`, read the way files.js reads it), `GET /chat/kind` (`path`), `GET /chat/files`
(`cwd`) and `GET /chat/commands` (`cwd`):

1. **Only inside a workspace:** a root `/state` lists (its repos, its removed workspaces, its added repos), or a
   conversation's repo root or repo folder that is a git checkout (it has a `.git` folder, or a worktree's `.git`
   file; a worktree's checkout is its own repo folder). The folder a conversation merely ran in does not count, and
   for a conversation in a folder that is no repo `/state` names that folder as its repo, so it does not count
   either.
2. **Never a workspace that is:** a drive's top (or `/`); the home folder or a folder above it; a folder in a
   dot-folder of the home folder (`~/.ssh`, `~/.claude`, `~/.config`...), or inside or holding the folder a
   dot-entry of the home folder really is (a link or junction may lead off it: `~/.claude` is
   `J:\Cache\ClaudeCode` on Henry's PC); or one inside, or holding, an app data folder (`%APPDATA%`,
   `%LOCALAPPDATA%`, `%PROGRAMDATA%`; on a Mac `~/Library`, on Linux the XDG config, data, state and cache folders),
   a folder a linked child of `%APPDATA%` or `%LOCALAPPDATA%` (the XDG folders elsewhere) really is, or Fleet View's
   own data folder (the API token, the sync sign-in, the relay keys). The home folder and those app data folders are
   read again each time the relay reads `/state`, not on every request.
3. **Below the workspace, no step whose name starts with `.`**, except `.github`: no `.git`, `.claude`, `.env*`,
   `.vscode`...
4. **No secret's name anywhere in the path:** `.env*` (but `.env.example`, which rule 3 refuses anyway), `*.pem`,
   `*.key`, `*.p8`, `*.p12`, `*.pfx`, `*.ppk`, `*.jks`, `*.keystore`, `*.kdbx`, `*.tfstate`, `*.tfstate.backup`,
   `*.tfvars`, `*.gpg`, `*.asc`, `*.age`, `*.keychain-db`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`,
   anything with `credential` in it, `*service-account*.json` and `*adminsdk*.json`, `google-services.json`,
   `GoogleService-Info.plist`, `.npmrc`, `.netrc`, `_netrc`, `.git-credentials`, `.pypirc`, `hosts.yml`,
   `secrets.json`, `secrets.yml`, `secrets.yaml`, `kubeconfig` (case ignored).
5. The path must pass as the phone named it and as it really is (links, junctions and short names resolved; for a
   path that does not exist, its nearest existing folder's), and may not name an alternate data stream (`:`).
6. **Listings leave out what the phone may not open:** a folder's `entries` from `GET /file` (and its `total`
   less them), and `GET /chat/files`' `files`.
7. **No key in a file's text, whatever its name:** a `GET /file` answer whose `text` holds `-----BEGIN ... PRIVATE
   KEY-----`, a `"private_key":` field or `"type": "service_account"` (spaces around the colon allowed) becomes 403,
   and none of the text goes.

Outside the fence `GET /file`, `/chat/kind` and `/chat/files` are 403, and `GET /chat/commands` goes on without its
`cwd` (the built-in commands and the phone's own). A path the server refuses anyway (not absolute, with no `cwd`)
goes on for the server's own answer. The pictures the compose box sent (Fleet View's `chat-images`) are in its data
folder, so `/file` does not serve them to the phone either.

### How the relay calls the server

Page routes get `Origin: http://127.0.0.1:<port>` on POSTs, as the page sends. `/api/*` routes get
`Authorization: Bearer <the API token>` (`<dataDir>/api-token`) and no `Origin`, because api.js refuses any request
that has one. The relay makes every header itself. No header the phone names is passed on, and the only phone value
that goes in a header is `etag`, as `If-None-Match`, which must be printable text.

### The relay's marker: what Henry sent from his phone

A bot reads text with no `from` as Henry's own words only when it comes from the phone (overseer.js frame), and api.js
lets only Henry make, change or remove a bot. Every Claude session on the PC can read the API token, so the token
alone can't prove either. The relay marks the phone's requests with **`"via": "phone"` in the body and the header
`X-Fleet-View-Relay: <key>`**. The key is api.js's `relayKey()`: it is made when the server starts and kept in
memory only (never on disk, logged or served), and fleet-view.js hands it to the relay
(`createRelay({ relayKey })`). api.js `viaOf` counts the mark only with both parts. A `"via": "phone"` without the
key counts as unsigned.

- **Who sets it:** the relay alone, on the routes api.js reads it on: `POST /api/sessions` (the prompt),
  `/api/sessions/:id/message`, `/api/sessions/:id/answer` (a free-text answer), `/api/sessions/:id/open` (the
  prompt), `/api/sessions/:id/model`, `/api/sessions/:id/mode`, `/api/sessions/:id/panel`, `/api/sessions/:id/rewind` and
  `/api/sessions/:id/fork` (an overseer's switch, panel keys, rewind or fork is Henry's alone; so is a shell command in its session, through `/message`), `/api/teams/:id/message`, and the
  bots' `POST /api/bots`, `/api/bots/:id`, `/api/bots/:id/remove` and `/api/bots/requests/:id/approve` and `/decline` (whose body is then just the marker). A task sent to a bot goes through `/message`, so it is marked too.
- **When:** only after the envelope opened with the device's own key, its nonce and `at` passed, the route is on
  the allowlist and its narrower rules passed.
- **Phone-sent copies:** the relay deletes `via` from every body the phone sends, on every route, before anything
  else reads the body. So the phone can't mark a request itself and can't unmark one. It never sends `via`.
- Without a key (an older server, or a bad one) the relay sends no marker at all, and says so once in
  `server.log`. The phone's text then reaches a bot as unsigned, and making a bot from the phone is refused.
- **What it proves, and what it doesn't.** The marker raises the bar for a local process that has only the API
  token: it can't pass its text off as Henry's. It is not proof against a process running as the same Windows user
  that can read the server's memory (a debugger, a memory dump): that one can get the key. Every Claude session
  runs as that user, so a bot should still weigh what a "Henry" message asks for.

## Several machines

Henry has two machines, the PC (BlackBox) and the Mac, and sync carries his chats between them: each chat has one
host, the machine that runs it (docs/sync-follow.md). The phone pairs with each machine on its own (the same pairing
as above, one QR code per machine) and talks to each over its own channel or socket.

- **What it keeps.** One pairing per machine, each under its own SecureStore key, and the list of them
  (`phone/src/pairing/pairings.ts`). Pairing another machine adds it to the list (Settings, Add a machine, or a
  chat's "Pair <name>"); the pair screen asks for that machine's way only. Every Blackbox pairing goes through the
  one Supabase project and account (a code for another is refused). A pairing also keeps what the machine's hello
  says about it, `device` and `platform`, from the first answer on. An app from before this kept one pairing under
  one key: the first launch moves it into the list as it is (its `K'` too), so nothing is paired again.
- **Reads** (`/state` and everything not about one chat) go to one machine that is online: the one that answered
  last while it stays online, else the first online. A machine's `/state` lists every chat it knows, its own and the
  synced ones.
- **A chat's requests go to its host** (`phone/src/transport/multi.ts`, `phone/src/lib/hosts.ts`): send, answer,
  interrupt, now, unsend, model, enter, background, mode, panel, rewind, fork, activity, menu, the session, the transcript, `/conversation`
  and its pictures, and,
  for the chat on view, the routes that read its folder (`/chat/image`, `/upload`, `/chat/files`, `/chat/commands`,
  `/chat/kind`, `/file`). The host is the chat's `workspace.host` in `/state` (null: the machine that listed it), or
  for an older machine its `syncOwner` (not one moving `away` from the lister), else the machine that listed it. A
  host is matched to a pairing by its sync device id, and by name only when that machine sends no `device`.
- **A host the phone can't reach.** Not paired with it: the chat says "This chat runs on <name>. Pair <name> to type
  here." and offers the pairing. Offline: "<name> is offline. Its chats come back when it's on." (no chat moves
  between machines since 2026-10-17, the main computer: docs/sync-follow.md; the phone reads `GET /sync/main` every
  30 s and reads chats from the main computer first). A bound chat
  (`workspace.kind: 'bound'`, a folder only its host has) says "Only on <name>, which is offline." Either way the
  feed, its pictures and the transcript still come from the reading machine's synced copy, and nothing else is sent:
  each such request fails at once, nothing sent, with those words.
- **A chat started from the phone** (a fork from a message too) stays on the machine that started it (its `new-<n>` key, then its id) until
  `/state` names its host, and so does one taken over with Continue on; at most 10 minutes.
- **Per machine:** a machine that revokes the phone, or no longer takes its pairing, drops that one pairing, with a
  note naming it; the last one gone is the same as Unpair. The same machine paired again (the same sync device id)
  drops the older pairing. Settings lists the machines (online or last seen, the Fleet View version); a tap
  unpairs that one only.

## Notifications

Each machine pushes its own alerts to the phones paired with it, through Expo's push service (which hands them to
Apple). No new dependency on the PC: `phone-push.js`, started by the relay, calls
`https://exp.host/--/api/v2/push/send` with plain `fetch`.

- **What a push says.** The relay is end-to-end encrypted, and a push is not: Expo and Apple see what it says. With
  the phone's Settings switch **Show what chats say** on (the default) a push is about one chat: its name as the
  title (a team's name for a member, the member then in the subtitle), what happened as the subtitle (`Finished · <repo>`,
  `Asks you · <repo>`, `Waits on you`, `Hit an API error`, `Stuck mid-turn`, `Plan failed`, `Merged PR #<n>`) and a
  line of the chat's own words as the body, at most 240 characters: the start of its last reply (the one a bot's chat
  shows), the question it ends on (with the line before when both are short), or the prompt on its screen. Turned
  off, a push names only what happened: **"A chat needs you"** (an alert of kind `question`, `error` or `stalled`,
  or a plan that did not finish), **"A chat finished"** (`done`) or **"A PR merged"** (`merged`), never a chat's
  name, its words or a PR's number. Either way data `{ sid, kind, machine, team? }` (`kind` `needs`, `finished` or
  `merged`; `machine` the pairing's `dev`; `team` when the chat is a team member). A phone from before the switch
  was on by default (it kept `names: false` without a choice) gets it on; one Henry turned off stays off
  (`namesSet`).
- **A bot a session asks for** (`/state`'s `botRequests`) pushes once, as it arrives: "<the session's name, or A
  session> asks to make a bot: <name>" with its role (else its why) as the body; with Show what chats say off, "A
  session asks to make a bot" alone. Data `{ kind: 'bot-request', machine, request: <its id> }`: a tap opens the Bots
  tab. The newest one seen is kept in `push.json` as `reqAt`, so a restart sends nothing twice.
- **A bot a session made** (`/state`'s `bots` with `bySession`: a session made it with `fv bot new` because Henry
  told it to) pushes once, after the fact: "<the session's name then, or A session> made a bot: <name>" with its
  role as the body; with Show what chats say off, "A session made a bot" alone. Data `{ kind: 'bot-made', machine,
  bot: <its id> }`: a tap opens the Bots tab, where Henry can remove it. The newest one seen is kept in `push.json`
  as `madeAt`, the same way.
- **The token.** The phone asks iOS for permission once, not on a first launch: after a minute in front while paired
  and a machine is online, an alert says what notifications say (and that Settings can leave a chat's words out), and only its "Turn on" brings up iOS's question
  (Settings' **Notifications** switch asks too). It then sends its Expo push token to every machine it is paired with:
  `POST /push/token { token, names, peers }`, the relay's own route (answered by the relay, never passed to the
  server; a phone's only, 403 for a computer; 403 for any other key, 400 for a token that is not
  `Expo(nent)PushToken[...]`, a `names` that is not true or false, more than 8 `peers`). `peers` are the sync device
  ids of the other machines that took the token, so a machine leaves a chat another one runs (`workspace.host`) to
  that machine and the phone hears it once. `{ token: null }` (notifications off) drops it. The relay keeps it on the
  device's record in `devices.json` (`push: { token, names, peers, at }`); `GET /relay/status` says only `push: true`.
  Revoking the device drops it, and so does Expo answering `DeviceNotRegistered`. An older Fleet View answers 403,
  and the phone does not ask it again until something changes.
- **What goes when.** `phone-push.js` reads this server's `GET /state` alerts every 5 s (with `If-None-Match`), only
  while some phone has a token. Per chat (a team's members as one: its group chat) and kind: needs once in 3 minutes,
  finished once in 2, merged once per PR; a chat with two kinds in one read gets the more urgent (needs, merged,
  finished). Several chats of a kind in one read: a push each up to 3 with Show what chats say on, else one push for
  them all ("4 chats need you", the first two names and how many more, no `sid`). The newest alert `n` seen is kept in `<dataDir>/relay/push.json` with
  the coalescing times, so a restart sends nothing twice; the first read with no cursor, and the first after no phone
  had a token, send nothing (no burst of old alerts), and an alert over 10 minutes old is never sent.
- **On the phone.** A tap opens the chat (`data.sid`) or the team's group chat (`data.team`); one about several chats
  opens the app as it was. While the app is in front a push shows, unless it is about the chat on view. Turning
  Notifications off also unregisters the phone from iOS's push, so nothing shows even from a machine that has not
  heard yet (on registers again); a registration a machine did not take is sent again every 30 s and at each
  comeback to the front, and an offline machine gets it once it is online. The phone's
  code: `phone/src/lib/push.ts` (prefs, where a tap goes, the registration) and `phone/src/data/push.tsx`.
- **Build.** `expo-notifications` is native (the app's 0.6.0 build), with `aps-environment` production. Expo's push
  service needs the APNs key for `com.glodusk.fleetview` on EAS (`eas credentials`, iOS, Push Notifications).

## The relay on the PC

- `relay.js` runs inside the Fleet View server. Its Supabase side is off unless sync S1 is set up and signed in and
  a phone is paired (or pairing). Before that it opens no socket and reads no key. It speaks the
  Phoenix protocol itself (Node's global `WebSocket`, `vsn=1.0.0`): join with the access token, a heartbeat every
  25 seconds, the new token on refresh, presence `track`, and a backoff reconnect (1 s doubling to 60 s).
- **Host-agnostic.** It takes the server's port, the data folder, the API token and the S1 instance from whoever
  starts it, and assumes nothing else about the PC. That way it can move to a cloud host later (Henry wants the
  session host on Supabase Compute once that leaves its waitlist).
- **Devices:** `<dataDir>/relay/devices.json` lists `{ id, name, mode: "relay", state: "pending" |
  "paired", createdAt, exp?, pairedAt?, lastSeen?, app?, device?, push? }` (`push`: the phone's notifications token,
  see "Notifications"; a file from before modes has no `mode`: relay;
  a device with `mode: "local"`, paired on the Wi-Fi before that way was taken out, is dropped at start with its key).
  The keys are kept apart, in `protectedStore(<dataDir>/relay,
  'relay-keys')`, as one JSON object: per device `{ k }` (its own `K'`) once the pairing finished, or
  `{ k, qr: { until, next, n? } }` while it pairs (`k` is `K`, which opens hellos until `until`, `next` the `K'` the
  handshakes made, and `n` how many handshakes it made, when any). `GET /relay/status` says `finished` for a paired
  device, and `handshakes` (that `n`) for one still pairing.
- **Computers:** another of Henry's machines, linked by itself through sync ([link.md](link.md)), is a device too, with
  `kind: "computer"` and `peer` (its sync device id). It never pairs with a QR code: `link.js` makes its key and adds
  it paired (`addComputer`), and unlinking removes it (`removeComputer`, the notice `revoked`). It is served like a
  phone, tracks the presence key `peer`, and may also call the `/peer/...` routes. The iPhone card does not list it.
- **Routes (on the PC only, never through the relay):** `GET /relay/status` (`{ enabled, signedIn, email,
  connected, devices }`, never a key), `POST /relay/pair { name?, mode? }`
  (`{ id, mode, link, svg, exp }`) and `POST /relay/revoke { id }`.
- **CLI:** `node relay.js status | devices | pair [--name N] | revoke <id>`. It talks to the running
  server. `pair` also writes `<dataDir>/relay/pair.html` with the QR code, to open in Fleet View's viewer.
- **The page:** the header's iPhone button shows on this PC whether or not sync is set up. Its card pairs through
  Blackbox while sync is set up and signed in (else it points to the Sync card), and lists the phones.
- **Log:** `<logDir>/relay.log`: time, device, method, path, status, ms, bytes. Never a body, a key or a token.

## The app

- `phone/` in this repo: Expo SDK 57, TypeScript, expo-router. The name is "Fleet View", the bundle
  `com.glodusk.fleetview`, the scheme `fleetview`. It ships to TestFlight only, and is left out of the share repo.
- **Pairing.** The app opens on the pair screen until it is paired: the computers in the lobby, or a pairing code.
  An older app's start screen pick (AsyncStorage `fv.way`) is cleared at launch. The iOS keys the Wi-Fi way needed
  (`NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking`, from app version 0.2.0) went with the 0.6.0 store
  build.
- One `Transport` interface with three implementations: `RelayTransport` (release; over `SupabaseCarrier`),
  `DirectTransport` (`__DEV__`
  only: `http://localhost:4777` through `adb reverse tcp:4777 tcp:4777`, with the `Origin` header for page POSTs and
  the API token pasted into a dev field), and `MockTransport` (the fixtures in `web/fixtures/`).
- Crypto: `@noble/ciphers` (AES-GCM), `@noble/hashes` (HKDF-SHA256), `@noble/curves` (X25519, pinned at 2.4.0)
  and `fflate` (raw DEFLATE), tested against `docs/phone-vectors.json`.
- The pairings (one per machine, see "Several machines") and the Supabase session live in SecureStore. AsyncStorage caches the last `/state` and the newest
  items of chats already opened, so the app still reads (but cannot send) while the PC is offline. The first launch
  after an install clears SecureStore, because the Keychain survives a reinstall.
- Shared code comes from `web/` through Metro `watchFolders`: `web/chats-model.js` (`buildContacts` takes raw
  `/state`) and `web/mascot.js` (`mascotSVG` returns an SVG string for react-native-svg's `SvgXml`). Web logic that
  has a pure module is imported, never copied.
