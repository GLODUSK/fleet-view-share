# Fleet View for iPhone: the relay protocol (v2)

The phone app (`phone/`, Expo) shows Cards, Wall and Projects (Projects as a Claude-app-style chat list with the
Chats tab's bots, Chief and team group chats). It never calls the server's routes itself: the PC's **relay**
(`relay.js`, inside the Fleet View server) opens each encrypted envelope, checks it, and answers the phone by calling
the server's own routes over loopback. The envelopes travel one of two ways, picked on the phone's start screen (and
in the PC's Pair an iPhone dialog) when it pairs:

- **Sync with Blackbox** (mode `relay`, recommended): both sides join a private **Supabase Realtime Broadcast**
  channel. Works from anywhere. Nothing is stored in the database: Supabase only carries encrypted envelopes. There is
  no open port and no Tailscale.
- **Work locally** (mode `local`): the phone, on the same Wi-Fi as the PC, opens a WebSocket straight to the PC's
  Wi-Fi listener (`relay-lan.js`, port 4779 on the PC's private addresses only). No Supabase, no sign-in, no sync set
  up on the PC at all. See "Work locally" below.

The envelopes, the keys, the handshake and every check below are the same for both; only the carrier and the topic in
the AAD differ.

This file is the contract between `relay.js` and the app. `docs/phone-vectors.json` holds fixed inputs and the exact
outputs of the crypto below. It is made by `node scripts/phone-vectors.js` with node's own crypto, and both sides
test against it.

Protocol v2 (this one) differs from v1 in one place: the key in the QR code only pairs. The first hello makes the
device's own key with an X25519 exchange, and from then on the QR code opens nothing. A v1 pairing is not read by a
v2 relay: that phone pairs again. Nothing was paired for real under v1.

## The three locks

(For a local pairing the first lock is the network instead: only a device on the same network reaches the listener,
and it gets nothing without the device key. See "Work locally".)

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
| `topic` | `fleet:<uid>:<dev>`. On the wire realtime-js sends `realtime:fleet:<uid>:<dev>`, and `realtime.topic()` in the policies returns it without `realtime:`. A local pairing's is `fleet:local:<dev>` (`local` where the uid would be): it is only in the AAD, nothing is joined |
| `K` | the pairing key: 32 random bytes in the QR code, for the handshake only |
| `K'` | the device's own key, made by the handshake; every message after it goes under `K'` |
| b64u | base64url with no padding (RFC 4648 section 5). Envelope fields use it |
| b64 | standard base64 with padding. Binary bodies (`b64`) use it, so they drop straight into a `data:` URL |

## Pairing

1. On the PC, the page's "Pair an iPhone" card calls `POST /relay/pair { name?, mode? }` (`mode` `"relay"`, the
   default, or `"local"`), or run `node relay.js pair [--name N] [--local]`. The relay makes `dev` and `K` and keeps
   the device as `pending` for 10 minutes. It answers with the pairing link and its QR code as SVG. `K` is shown only
   then, and is never logged. `relay` needs sync set up and signed in (409 otherwise); `local` needs neither, only a
   private address on this PC (409 "no address on a home network" otherwise), and the Wi-Fi listener running (503 when
   it could not listen, say the port is taken).
2. The link is `fleetview://pair?d=<b64u of the UTF-8 JSON>`:

   ```json
   { "v": 2, "url": "https://<project>.supabase.co", "key": "<publishable key>", "uid": "<uid>",
     "email": "<the PC's Google email>", "pcName": "<the PC's name>", "dev": "<dev>", "k": "<b64u of K>",
     "exp": 1760141400000 }
   ```

   and for a local pairing (no Supabase url, key, uid or email: the PC's private addresses the listener got, in
   order, and its port):

   ```json
   { "v": 2, "mode": "local", "hosts": ["192.168.1.20"], "port": 4779, "pcName": "<the PC's name>", "dev": "<dev>",
     "k": "<b64u of K>", "exp": 1760141400000 }
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
   A local link is refused unless every host is a private IPv4 address (10/8, 172.16/12, 192.168/16, written
   plainly; 1 to 8 of them) and `port` is a port. There is no sign-in: the phone saves `{ mode: "local", hosts,
   port, pcName, dev, k }`, opens the socket, and starts the handshake. A code of the other kind than the way picked
   on the start screen is refused with words that name the right one.
4. **The handshake.** While its stored key is `K`, the phone sends nothing but a `hello`, sealed under `K` like any
   envelope, with one more field: `epk`, the b64u of a fresh X25519 public key (its secret stays in memory for this
   one hello). The relay, for a hello under `K` before its time is up:
   - makes its own fresh X25519 key pair and `K' = HKDF-SHA256(ikm = K || X25519(its secret, epk), salt: none,
     info = "fleet-view relay v2 paired", length 32)` (`||` joins the bytes; "none" is HKDF's zero-length salt);
   - **keeps `K'` in its key store before it answers**, next to `K` and the `K'` of any earlier handshake (4 at
     most), and marks the device `paired`;
   - answers under `K`: `res` 200 `{ paired: true, pcName, version, epk }` with its own public key.

   The phone makes the same `K'` from its secret and the PC's `epk`, and **saves `K'` in place of `K` in the one
   SecureStore write that holds the pairing** (`own: true` marks it), before anything goes under `K'`. The first
   thing that does is a `hello` under `K'` (no `epk`), answered 200 `{ paired: true, pcName, version }`.
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
8. **Revoke:** `POST /relay/revoke { id }` or `node relay.js revoke <id>`, for either mode. The relay sends `notice`
   `revoked`, leaves the channel (a local device: closes its sockets after the notice, and the listener 404s it from
   then on) and deletes the key; a request of that device still being checked is dropped before it reaches
   the server. On that notice the phone wipes its pairing and its cached data. "Unpair" on the phone only forgets
   the pairing on the phone; the PC lists the device until it is revoked.

## The channel

- Both sides join `topic` with `{ private: true, broadcast: { self: false, ack: false }, presence: { key } }`,
  with key `"pc"` or `"phone"`, using their own Supabase access token. The PC sends its new token on every refresh
  (the `access_token` message), and it leaves and joins again when S1 says `signed-in` or `signed-out`
  (`onChange`). S1's config is read again on every (re)connect, never cached.
- **Presence:** the PC tracks `{ role: "pc", v: 1, at }` under key `pc`. The phone shows "PC online" while that key
  is present and "PC offline since <time>" when it is not. The phone tracks `{ role: "phone", v: 1, at }`, and the
  PC only uses it for the device's `lastSeen`.
- Every message is one broadcast, event `"e"`, whose payload is the envelope.

## Work locally (the Wi-Fi carrier)

A local pairing reaches the PC with no Supabase at all. The phone's transport is the same `RelayTransport` (the same
envelopes, crypto, hello and handshake, ids, retries, parts and notices); only its **carrier** differs
(`phone/src/transport/carrier.ts`: `SupabaseCarrier` for Blackbox, `LanCarrier` for the Wi-Fi). On the PC, envelopes
from the listener go through exactly the same `onEnvelope` as Supabase ones: the device key, nonces, skew, the
allowlist and its narrower rules, the fence, every limit, the hello rate limits and the marker. The topic in their AAD
is `fleet:local:<dev>` on both sides, so an envelope made for one carrier never opens on the other.

**The phone (`LanCarrier`).** It opens `ws://<host>:<port>/fleet/<dev>`, one envelope per JSON text message each
way. It tries the link's hosts in turn (the one that worked last first); an attempt not open within 5 s is given up;
after a whole round failed it waits 1 s, doubling to 30 s, and says "Can't reach the PC on this Wi-Fi" (with what to
check: the same network, Fleet View running, iOS's Local Network permission). The link is up (`connected`) and the PC
is there (`pcOnline`) while the socket is open; a socket that closes reports the PC offline (the banner) and is opened
again a second later. On open the transport says hello at once (the handshake while the key is still `K`), which also
proves the socket on the PC. The app coming back to the front tries at once. A message down over 4 M characters, or
not JSON, is ignored. iOS: `NSLocalNetworkUsageDescription` (iOS asks once) and `NSAppTransportSecurity`
`NSAllowsLocalNetworking` (plain `ws://` to a private address) in `phone/app.json`.

**The PC (`relay-lan.js`, the listener).**

- On only while relay.js wants it: a local-mode device paired or pairing (with its key). Off otherwise, and off
  whatever sync says; it never makes the Supabase socket open, and Supabase never makes it listen.
- Its own port, **4779** (`createRelay({ lanPort })`), bound to each of the PC's **private IPv4 addresses**
  (10/8, 172.16/12, 192.168/16), one server each: never `0.0.0.0`, never a public, loopback, link-local or CGNAT
  (Tailscale's 100.64/10) address. A virtual adapter's private address (WSL, Hyper-V, Docker, VirtualBox) is left out
  whenever a real adapter has one (else it is all there is, as on a PC whose LAN is a Hyper-V external switch); the
  link's `hosts` go 192.168/16, then 10/8, then 172.16/12. The addresses are read again every 30 s (a new Wi-Fi address picked up, a gone one let go). A PC
  whose address changes later (a new DHCP lease) needs a new pairing: the phone only knows the hosts its code named. The page's server stays on 127.0.0.1:4777 only; nothing on the listener reaches it except the relay's own
  `forward()` after an envelope passed every check.
- It serves **one thing**: the WebSocket upgrade `GET /fleet/<dev>` (exactly that path, no query), version 13, for a
  `dev` that is a known local device; the `Host` header must be the address and port it was reached on (no DNS
  rebinding), and an `Origin`, when there is one, must be `http://<that host>` (what the phone's WebSocket sends; a
  page in a browser on the network sends its own and is refused). Everything else, plain requests included, gets a
  bare `404` (no body, no `Date`, no server name) and the socket is closed; a malformed request is closed without a
  word. Nothing goes down a socket until an envelope came up on it that opened under the device's key and is fresh
  (its `at` within the skew window: an old envelope replayed opens but proves nothing) (a "proven" socket), and only
  proven sockets get answers or notices.
- **Answers go back down the socket the request came on** (a repeat's kept answer too); when that socket is gone, the
  device's newest proven one. Notices (`revoked`, `pc-closing`) go to every proven socket of the device.
- **Limits** (`relay-lan.js` `LIMITS`): 16 sockets in all and 8 from one address (past either: the socket is
  dropped with no answer); 4 per device (the oldest one not proven yet makes room; a proven one never does, so a
  stranger can't push the phone off); 64 TCP connections per listening address and 8 from one address before any upgrade; 5 s
  (checked every second) and 4 KB for the request headers; one message at most the relay's `C_MAX` plus 1 KB, checked from the frame header before the body is read
  (1009), and at most 1024 frames to one message (1009); 64 messages and 256 frames of any kind (pings and
  continuations too) a second per socket (1008); once the close handshake started, every frame but the close is
  ignored; a socket must prove itself within 15 s (1008); one not proven yet is
  closed at the first envelope that does not open (or names another device, or is a replay), a proven one after 8;
  a ping every 25 s, two missed and it goes; a proven socket that sent no envelope for 10 minutes is closed (the phone
  opens another); 128 MB waiting to go out to a phone that stopped reading drops its socket (64 KB for one not proven yet). The frames are
  `ws-frames.js` (RFC 6455, shared with `live.js`): client frames must be masked, no extensions, control frames whole
  and at most 125 bytes.
- **Windows Firewall.** The first time the listener binds, Windows may ask whether Node.js (node.exe) may use the
  network. It must be allowed on **Private** networks, or the phone can't connect. The PC's Pair an iPhone dialog
  says so.

**Threat notes.** Anyone on the same network can reach the listener, and `ws://` is plain: what protects the phone and
the PC is the envelope, as on Supabase.

- *A stranger without the device key* gets a 404 for every path, a 404 for an unknown `dev`, and for a known `dev` a
  socket that stays silent and is closed at its first bad envelope or after 15 s. No route, no PC name, no version,
  no answer: there is nothing to amplify. The device id is 96 random bits (a passive listener on the Wi-Fi can see it
  in the path, which only lets it open that silent socket).
- *A passive listener on the Wi-Fi* sees the device id, when the phone talks and how much, never what: the envelopes
  are AES-256-GCM under the device's own `K'`, which the QR code never held.
- *An active one* (ARP spoofing, a rogue access point) can drop, delay or replay envelopes. A replay is dropped by the
  nonce (10 minutes, per device, both carriers) and `at` checks (5 minutes, and nothing from before the relay
  started); a forged or changed one does not open; a POST sent again after a restart gets 409, never runs twice. It can
  keep the phone from reaching the PC (a denial of service), as it could any local traffic.
- *The pairing code* shown on the PC is, until the phone pairs, the same secret as for Blackbox: anyone on the network
  who scans it in its 10 minutes could pair in Henry's place (for Blackbox they would also need his Google account).
  After the phone's first envelope under its own key, the code opens nothing.
- *A web page* in a browser on the network (or on the phone) can't use the listener: its `Origin` is refused, a
  rebound host name fails the `Host` check, and it has no key.
- *Every relay check holds*: the allowlist, the fence, the start limits, the marker (which only the relay sets) and
  the in-flight caps apply to local envelopes exactly as to Supabase ones; the listener adds its own caps in front.

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
  | `POST /api/sessions`, `/api/chief/start`, `/api/bots`, `/api/bots/:id/start` (they start a Claude: the server waits up to 60 s for it to be ready, settles, then types; `POST /api/bots` makes the bot and starts it); the page's `/bots/:id/tasks/:taskId` (Run now starts the bot first when it is not running) | 95 s | 95 s + the wait | 100 s (+ the wait) |
  | `POST /api/sessions/:id/message` and `/open`; `POST /api/teams`, `/api/teams/:id/add`, `/lead` and `/message`; the page's `/teams`, `/teams/add` and `/teams/lead` (each may resume a stopped conversation first, up to 60 s, before it types) | 75 s | 75 s + the wait | 80 s (+ the wait) |
  | any other `/api/*` POST with `wait` (e.g. `/answer`) | 60 s | | the wait + 15 s |
  | `GET /api/sessions/:id/activity` (the chat's activity line, polled) | 5 s | | 20 s |
  | `POST /api/sessions/:id/now` (send now) | 10 s | | 20 s |
  | `POST /api/sessions/:id/model` (a model or effort switch: `/model`, `/effort`, the default put back), and the page's `/bots/:id/switch` (the same, for a dynamic bot) | 20 s | | 25 s (the caller sets `timeoutMs`) |
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
characters (a 15 MB image as base64 in `POST /chat/image`), and the phone sends at most 20 parts a second: every part
counts against the relay's per-second limit, and a part over it is dropped, not answered.

### Limits

Per device, on the relay:

- **20 requests in flight.** Over that: 429, `retryAfter` 1000.
- **30 envelopes a second and 1,200 a minute**, counting every envelope that opens: requests, their repeats, parts
  and hellos. Over that, a `req` or `hello` gets 429 with `retryAfter`, and a part is dropped.
- **The routes that start or resume a Claude: 2 at once, and 12 in 10 minutes.** Each counts one (`POST
  /api/sessions`, `/api/sessions/:id/open`, `/api/chief/start`, `/api/bots`, `/api/bots/:id/start`,
  `/api/teams/:id/add`, the page's `/teams/add`, and the page's `/bots/:id/tasks/:taskId` with `action: "run"`), a team one per distinct member (`POST /api/teams`, the page's
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

**GET:** `/state`, `/conversation`, `/conversation/image`, `/repo-history`, `/chat/commands`, `/chat/files`,
`/chat/kind`, `/file`, `/since`, `/chief/briefing`, `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/menu`,
`/api/sessions/:id/transcript` (with `queue`, the messages queued in Claude Code), `/api/sessions/:id/activity`,
`/api/conversations`, `/api/teams`, `/api/status`, `/accounts`.

**POST:** `/api/sessions`, `/api/sessions/:id/message`, `/api/sessions/:id/answer`, `/api/sessions/:id/interrupt`,
`/api/sessions/:id/open`, `/api/sessions/:id/stop`, `/api/sessions/:id/remove`, `/api/sessions/:id/now`,
`/api/sessions/:id/unsend`, `/api/sessions/:id/model`, `/api/teams`,
`/api/teams/:id/add`, `/api/teams/:id/remove`, `/api/teams/:id/lead`, `/api/teams/:id/disband`,
`/api/teams/:id/message`, `/api/chief/start`, `/api/bots`, `/api/bots/:id`, `/api/bots/:id/start`,
`/api/bots/:id/remove`, `/settings`, `/rename`, `/sessions/move`, `/push-target`, `/repos/remove`, `/repos/add`,
`/chat/image`, and the page's `/teams`, `/teams/add`, `/teams/remove`, `/teams/leave`, `/teams/lead`,
`/teams/rename`, `/bots/:id/switch` and `/bots/:id/tasks/:taskId`, and `/accounts/add`, `/accounts/login`,
`/accounts/code` and `/accounts/cancel` (only to sign in a missing Claude A or B, below).

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

The Chief and the bots:

- `GET /chief/briefing` is the Chief's free briefing (chief.js: who needs Henry, what is working, finished and
  deployed, and the same as a few lines). `POST /api/chief/start { account?, model?, effort? }` starts the Chief,
  or adopts the one running: `{ ok, id, key, started }`, and 503 while the desktop app (the session host) is not
  running. The relay passes on only `account`, `model` and `effort` and drops anything else. The Chief starts
  only this way: `POST /api/sessions` with a `role` in its body (any value) is 403.
- **Bots** (bots.js, api.js): `POST /api/bots { name, brief?, account?, model?, effort?, shape?, color? }` makes a
  bot and starts it, `POST /api/bots/:id { name?, brief?, account?, model?, effort?, shape?, color? }` changes one
  (the phone's Edit bot sends only what changed), `POST /api/bots/:id/start` starts one, `POST /api/bots/:id/remove`
  takes one off the list. `model` and `effort` may each be `"dynamic"` (a new bot's default: each message is sized
  for it); `shape` is one of web/mascot.js `SHAPES` and `color` a `#rrggbb`, `null` for the automatic pick. A bot id
  is 12 lowercase hex digits (bots.js `BOT_ID_RE`). api.js takes making, changing and removing a bot only from
  Henry, which from the phone means the relay's marker (below); starting one is open to any caller, so `/start` is
  not marked. A message for a bot goes through `POST /api/sessions/:id/message` to its conversation (`convId` in
  `/state`'s `bots`), as for any session. `POST /api/bots/look` (a bot changing its own look) is the bot's alone,
  never the phone's.
- **A dynamic bot's switch** (bots.js `switchTo`): before a message to a bot whose model or effort is `"dynamic"`,
  the phone sizes the message from its words (web/chats-model.js `sizeTask`) and, when that differs from what its
  session runs now, asks the PC to switch first: the page's `POST /bots/:id/switch { id, model?, effort? }`, `id` its
  conversation. It is a page route, so it goes with this PC's Origin (fleet-view.js lets only the page switch a bot)
  and is not marked.
- **A bot's tasks and routines** (bots.js, bot-tasks.js): `/state`'s `bots[].tasks` lists each bot's tasks.json
  (`tasksError` when it can't be read), and the page's `POST /bots/:id/tasks/:taskId { action }` acts on one:
  `pause`, `resume`, `run` (send it to the bot now, started first if it is not running) or `delete`. A task id is
  1 to 64 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. A page route too: this PC's Origin, not marked.

Narrower rules:

- `POST /settings` may set only `repo`, `repos`, `hidden`, `hiddenRepos`, `finishedOpen`, the list features'
  `repoNames`, `repoOrder` and `forgotten`, and `chief`. Any other key makes the whole request 403. `repo` and each
  `repos` entry that is a path (a bare name only filters by name), and each `hiddenRepos` root, must be a root Fleet
  View already knows (`/state`'s repos, its removed workspaces, its added repos); each `repoNames` and `repoOrder`
  root may also be one the list features' settings already hold. The Chats window keys (`chatsBounds`,
  `chatsOpen`, `chatsOnTop`) stay off: they are desktop state.
- `chief` in `POST /settings` must be `{ watch: true | false }` (the Chief's watch mode), else 400. Only `watch`
  goes on: the `id` that `/state`'s `settings.chief` carries (and anything else in it) is dropped, so the phone
  may send back what it read with `watch` changed.
- `POST /api/bots` and `POST /api/bots/:id` take only `name`, `brief`, `account`, `model`, `effort`, `shape` and
  `color` (what bots.js reads; it checks the values itself); any other key, `folder` included, makes the request
  403. `POST /api/bots/:id/start` and `/remove` take no fields at all (403 otherwise).
- `POST /bots/:id/switch` takes only `id`, `model` and `effort` (403 otherwise): `id` a conversation id, and at
  least one of `model` (a name api.js `MODEL_RE` takes) and `effort` (`low` to `max`), else 400.
  `POST /bots/:id/tasks/:taskId` takes only `action` (403 otherwise), one of `pause`, `resume`, `run`, `delete`
  (400 otherwise). The page's other bot routes (`/bots`, `/bots/:id`, `/start`, `/remove`) stay off: the phone uses
  the `/api/bots` ones.
- **The chat's verbs** (api.js): `POST /api/sessions/:id/now` (the page's Interrupt on a queued message: Claude
  takes what is queued now) takes no fields (403 otherwise) and counts toward no start limit.
  `POST /api/sessions/:id/unsend { text }` takes only `text` (403 otherwise), which must be text as api.js
  `cleanText` takes it: something besides spaces, no control characters but new lines and tabs (400).
  `POST /api/sessions/:id/model { model?, effort? }` takes only those two (403 otherwise), at least one, `model` a
  name api.js `MODEL_RE` takes and `effort` one of `low`, `medium`, `high`, `xhigh`, `max` (400); it is marked,
  because api.js switches an overseer's model only for Henry (on any other conversation the marker changes nothing).
  `POST /api/sessions/:id/message` may carry `now` (send it at once, stopping the step Claude is on), which must be
  true or false (400). `GET /api/sessions/:id/activity` takes nothing.
- `POST /repos/add` takes only a root Fleet View already knows (in `/state`'s repos or the removed list). The
  same goes for the roots of `/sessions/move`, `/push-target` and `/repo-history`.
- `GET /file`, `/chat/kind`, `/chat/files` and `/chat/commands`' folder are fenced: see the next section.
- `GET /conversation/image` serves only a known conversation's pictures; `POST /api/sessions` checks its repo and
  `forkFrom`, and the page's `/teams` routes take conversation ids.
- Everything else is refused, including `/reveal`, `/open`, `/update/*`, `/sync/*`, every other `/accounts/*` (`/accounts/remove` among them), `/remote*`,
  `/preview/*`, `/housekeeping/*`, `/folders`, `/upload`, `/relay/*`, `/api/ask*` and `/api/sessions/:id/wait`.

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

A Chief (chief.js) reads text with no `from` as Henry's own words only when it comes from the phone, and api.js
lets only Henry make, change or remove a bot. Every Claude session on the PC can read the API token, so the token
alone can't prove either. The relay marks the phone's requests with **`"via": "phone"` in the body and the header
`X-Fleet-View-Relay: <key>`**. The key is api.js's `relayKey()`: it is made when the server starts and kept in
memory only (never on disk, logged or served), and fleet-view.js hands it to the relay
(`createRelay({ relayKey })`). api.js `viaOf` counts the mark only with both parts. A `"via": "phone"` without the
key counts as unsigned.

- **Who sets it:** the relay alone, on the routes api.js reads it on: `POST /api/sessions` (the prompt),
  `/api/sessions/:id/message`, `/api/sessions/:id/answer` (a free-text answer), `/api/sessions/:id/open` (the
  prompt), `/api/sessions/:id/model` (an overseer's switch is Henry's alone), `/api/teams/:id/message`, and the
  bots' `POST /api/bots`, `/api/bots/:id` and `/api/bots/:id/remove` (whose body is then just the marker). A task sent to a bot goes through `/message`, so it is marked too.
- **When:** only after the envelope opened with the device's own key, its nonce and `at` passed, the route is on
  the allowlist and its narrower rules passed.
- **Phone-sent copies:** the relay deletes `via` from every body the phone sends, on every route, before anything
  else reads the body. So the phone can't mark a request itself and can't unmark one. It never sends `via`.
- Without a key (an older server, or a bad one) the relay sends no marker at all, and says so once in
  `server.log`. The phone's text then reaches a Chief as unsigned, and making a bot from the phone is refused.
- **What it proves, and what it doesn't.** The marker raises the bar for a local process that has only the API
  token: it can't pass its text off as Henry's. It is not proof against a process running as the same Windows user
  that can read the server's memory (a debugger, a memory dump): that one can get the key. Every Claude session
  runs as that user, so a Chief should still weigh what a "Henry" message asks for.

## The relay on the PC

- `relay.js` runs inside the Fleet View server. Its Supabase side is off unless sync S1 is set up and signed in and
  a relay-mode phone is paired (or pairing); its Wi-Fi listener (`relay-lan.js`) is off unless a local-mode phone is,
  whatever sync says. With neither it opens no socket and reads no key. It speaks the
  Phoenix protocol itself (Node's global `WebSocket`, `vsn=1.0.0`): join with the access token, a heartbeat every
  25 seconds, the new token on refresh, presence `track`, and a backoff reconnect (1 s doubling to 60 s).
- **Host-agnostic.** It takes the server's port, the data folder, the API token and the S1 instance from whoever
  starts it, and assumes nothing else about the PC. That way it can move to a cloud host later (Henry wants the
  session host on Supabase Compute once that leaves its waitlist).
- **Devices:** `<dataDir>/relay/devices.json` lists `{ id, name, mode: "relay" | "local", state: "pending" |
  "paired", createdAt, exp?, pairedAt?, lastSeen?, app?, device? }` (a file from before local mode has no `mode`:
  relay). A local device's `lastSeen` is its last envelope that opened. The keys are kept apart, in `protectedStore(<dataDir>/relay,
  'relay-keys')`, as one JSON object: per device `{ k }` (its own `K'`) once the pairing finished, or
  `{ k, qr: { until, next, n? } }` while it pairs (`k` is `K`, which opens hellos until `until`, `next` the `K'` the
  handshakes made, and `n` how many handshakes it made, when any). `GET /relay/status` says `finished` for a paired
  device, and `handshakes` (that `n`) for one still pairing.
- **Routes (on the PC only, never through the relay):** `GET /relay/status` (`{ enabled, signedIn, email,
  connected, lan: { on, port, listening, addresses, sockets }, devices }`, never a key; each device has its `mode`,
  and a local one's `channel` is `joined` while a proven socket of its is open), `POST /relay/pair { name?, mode? }`
  (`{ id, mode, link, svg, exp }`) and `POST /relay/revoke { id }`.
- **CLI:** `node relay.js status | devices | pair [--name N] [--local] | revoke <id>`. It talks to the running
  server. `pair` also writes `<dataDir>/relay/pair.html` with the QR code, to open in Fleet View's viewer.
- **The page:** the header's iPhone button shows on this PC whether or not sync is set up. Its card offers **On this
  Wi-Fi** always and **Through Blackbox** only while sync is set up and signed in, says that the phone has to be on
  the same Wi-Fi and that Windows may ask once to let Fleet View (node.exe) on the network (allow it on Private
  networks), and lists the phones with their way.
- **Log:** `<logDir>/relay.log`: time, device, method, path, status, ms, bytes. Never a body, a key or a token.

## The app

- `phone/` in this repo: Expo SDK 57, TypeScript, expo-router. The name is "Fleet View", the bundle
  `com.glodusk.fleetview`, the scheme `fleetview`. It ships to TestFlight only, and is left out of the share repo.
- **The start screen.** Before it is paired the app asks once, with two big cards as the PC's own start screen does:
  **Sync with Blackbox** (recommended: works away from home; QR code, then Google sign-in) or **Work locally** (same
  Wi-Fi as the PC; no sign-in, nothing through Supabase). The pick opens the pair screen for that way (Back returns to
  the cards) and is kept (AsyncStorage `fv.way`) until it pairs; a pairing link opened before a pick picks the link's
  way. Settings shows the way, and switching is unpair plus the start screen again, after a confirm. A local pairing
  is always "signed in" (no Supabase session to follow). `expo.version` went to 0.2.0 with local mode, because its iOS
  keys (`NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking`) need a new native build: `runtimeVersion` follows
  the app version, so no update meant for 0.2.0 reaches a 0.1.0 build.
- One `Transport` interface with three implementations: `RelayTransport` (release; over `SupabaseCarrier` or
  `LanCarrier`, see "Work locally"), `DirectTransport` (`__DEV__`
  only: `http://localhost:4777` through `adb reverse tcp:4777 tcp:4777`, with the `Origin` header for page POSTs and
  the API token pasted into a dev field), and `MockTransport` (the fixtures in `web/fixtures/`).
- Crypto: `@noble/ciphers` (AES-GCM), `@noble/hashes` (HKDF-SHA256), `@noble/curves` (X25519, pinned at 2.4.0)
  and `fflate` (raw DEFLATE), tested against `docs/phone-vectors.json`.
- The pairing and the Supabase session live in SecureStore. AsyncStorage caches the last `/state` and the newest
  items of chats already opened, so the app still reads (but cannot send) while the PC is offline. The first launch
  after an install clears SecureStore, because the Keychain survives a reinstall.
- Shared code comes from `web/` through Metro `watchFolders`: `web/chats-model.js` (`buildContacts` takes raw
  `/state`) and `web/mascot.js` (`mascotSVG` returns an SVG string for react-native-svg's `SvgXml`). Web logic that
  has a pure module is imported, never copied.
