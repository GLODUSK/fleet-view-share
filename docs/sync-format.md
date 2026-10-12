# Sync: what goes up, and how it comes back (the S2/S3/S4 contract)

The uploader (`sync-up.js`, S2) and the materializer (`sync-down.js`, S3) never talk to each other: they meet only in
Supabase. This page is the format they share. `sync-api.js` is the connection ([sync.md](sync.md)), `sync-crypto.js`
seals every byte that leaves a machine, and [sync-move-recipe.md](sync-move-recipe.md) says how a conversation must be
laid down to resume. A change to anything here changes both sides in the same PR.

## What a conversation is made of

A conversation is the Claude Code session `<id>` (a UUID) in `<projects>/<slug>/`:

| file key | local path | kind |
|---|---|---|
| `main` | `<slug>/<id>.jsonl` | append-only log |
| `subagents/<name>` | `<slug>/<id>/subagents/<name>` (`agent-*.jsonl`, `agent-*.meta.json`) | `.jsonl` append-only, others whole |
| `tool-results/<name>`, `workflows/<...>` | `<slug>/<id>/tool-results/...`, `<slug>/<id>/workflows/...` | whole files |

Not synced: `custom-title.json` (Claude Code writes it again from the log), `file-history/`, `todos/`, `session-env/`,
`tasks/`, `sessions/`, `history.jsonl`, memory folders and handoffs (later, with settings). File keys use `/` and
each segment must match `[A-Za-z0-9._-]+`, never `.` or `..`; a file whose name does not fit is skipped and logged.

## Rows (schema `fleet_sync`, migration 0375; every row is the signed-in user's, RLS checks membership)

- **devices** `{ id, name, platform, last_seen_at }`: one per machine. The id is kept in `<dataDir>/sync/device.json`
  (`{ id }`), made on first start by inserting a row (name = hostname, platform = `process.platform`). Each side
  updates `last_seen_at` at most every 5 minutes, and S4's mover every 30 s (see [Moving a conversation](#moving-a-conversation-s4)).
- **repos** `{ id, origin }`: one per GitHub repo, `origin` normalized: `https://github.com/<owner>/<repo>` in lower
  case, from `git remote get-url origin` (ssh `git@github.com:o/r.git`, `https://user@github.com/o/r.git` and
  `.../o/r/` all become the same string). Other hosts: `https://<host>/<path>` the same way.
  One more row, **the home row**, has the origin `home:` exactly (`sync-common.js` `HOME_ORIGIN`; no git remote
  normalizes to it, and both sides read origins through `rowOrigin`). It stands for the user's home folder: a
  conversation whose folder is under the home folder but in no repo with an origin (a bot's folder, a scratchpad, a
  git repo with no origin, the home folder itself) syncs under it. Outside the home folder, or under its `AppData`,
  `Library` or `.claude-<letter>` folder (`homeSkipped`), and in no repo with an origin: a bound row (below). Nor
  while a `.git` above the folder is one git could not read (a time-out, no git): it waits for git, never the home
  row. Down here, a folder `homeSkipped` names, or one where a file sits, is never made: the home folder itself
  stands in.
  More rows, **the bound rows**, have the origin `bound:<device id>` (lower case; `sync-common.js` `boundOrigin`; no
  git remote normalizes to it either: `bound:x` as a remote reads as `https://bound/x`), one per device that hosts a
  bound conversation. See [Portable and bound](#portable-and-bound). No device writes a `repo_paths` row for one.
- **repo_paths** `{ device_id, repo_id, root }`: where this device has a checkout of that repo (the main checkout's
  top-level folder, `git rev-parse --show-toplevel`). Written by whichever side finds it. For the home row, `root` is
  that device's home folder (`os.homedir()`: `C:\Users\henry` on one, `/Users/henry` on another).
- **conversations** `{ id, account, repo_id, rel_cwd, branch, title_enc, state, owner_device, lease_until, size,
  sha256, generation, updated_at }`:
  - `account`: `a` or `b`: the Claude account it ran under, as the owning device learnt it from its claude process
    (and remembers after it ends), else the account whose projects folder holds it. A's projects folder is often a
    link to B's, so the folder alone would say `b` for every one. A change of account alone is a PATCH of the meta
    with no `updated_at`, `size` or `sha256`: nothing is laid down again for it.
  - `rel_cwd`: the folder the log lives in, relative to its repo root, with `/`, `''` for the root. That is the
    folder the session started in (its slug folder's), which it resumes from: a session started in the root that
    later moved into a worktree has `''`, not the worktree's path. The uploader takes the log's last `cwd`, or its
    first, whichever has the slug folder's name; when neither does, or that folder is in no repo, the last `cwd`.
    A conversation started in a worktree (`<root>/.claude/worktrees/<name>`) keeps that path as its `rel_cwd`; S3
    lays it down in the main checkout's slug folder for that path only if that folder exists on the device, else in
    the root's.
    A repo with an origin always wins: the home row is only the fallback when no repo with an origin holds the slug
    folder's `cwd` or the last `cwd` (a checkout under home, `/Users/henry/code/fleet-view`, keeps its repo row).
    Then `rel_cwd` is the slug folder's `cwd` (else the last `cwd`) relative to the home folder: `Bots/panchito`,
    `Scratchpads/scratch-2026-10-11`, `''` for home itself. That folder need not exist when it goes up.
    Under a bound row, `rel_cwd` is that folder's full path on the device that hosts it, with `/` between folders
    (`sync-common.js` `boundRel`): `C:/Perforce/ws` (a drive letter in upper case), `//server/share/x` (a Windows
    share), `/Users/henry/ws`. At most 1024 characters, no `.` or `..` or empty folder name (`boundRelOk`).
  - `branch`: the last `gitBranch` in the log, plain text.
  - `title_enc`: `sealText(title, key, 'title:<id>')`, the last `custom-title` (or `summary`) line's title.
  - `size`, `sha256`, `generation`: the `main` file's uploaded length, the hex sha256 of those bytes, its generation.
  - `owner_device`: the device that writes it. S2 sets itself on a new row and only uploads rows it owns (or with no
    owner). S4 moves it. `lease_until` is S4's (below).
- **settings** `{ key, value_enc }`: one row per key, upserted on `(user_id, key)`. S4's request rows (below), and:
  - `live:<device id>` (`sync-live.js`): what runs on that device right now, written by that device only, sealed with
    `sealText(json, key, 'setting:live:<device id>')`, `updated_at` set to its `at`:
    `{ v: 1, device, at, sessions: [{ id, state, label, stateColor, name, renamed, account, last, active, turnStart,
    waitingOn, agents, repo }], bound: [ids] }`. `bound` is the `bound:` row's list (below), kept here for a Fleet View
    from before that row, which reads it only here; it goes from the live row in a later release.
  - `bound:<device id>` (`sync-live.js`): every conversation that device runs whose workspace is only there
    ([Portable and bound](#portable-and-bound)), whatever its state: `{ v: 1, device, at, bound: [ids] }`, sorted, at
    most 5000, sealed and stamped like the live row, written by that device only and only when the list changes (at
    most every 5 s). A reader takes a device's list from its `bound:` row when it has one that opens, else from that
    device's live row's `bound` (an older Fleet View, which writes no `bound:` row; none: nothing bound). Another
    device keeps the last list it read while that device is offline, for at most 7 days (`sync-live.js`
    `TIMING.boundStaleMs`): a device known to be offline (by the `devices` heartbeat; not one not known yet) whose
    newest sign of life (its `live:` and `bound:` rows' `at`, its `devices.last_seen_at`) is more than 7 days behind the
    reader's clock has no bound list there (the bound row and the live row's copy alike), so a
    machine away for a week no longer holds conversations back. Nothing in the rows changed for this. In a `live:` entry, `repo` is `{ origin, name }` (the portable root of the `prefs:` rows: GitHub
    `owner/name` and folder name, either may be null) for the repo that device shows it under, or null; another
    device shows it under its own checkout of that repo when it has one (by origin, else a same-named folder with no
    origin), else works the repo out itself. A row from before `repo` (none on its entries) still counts. `sessions` lists the conversations it owns that are not DONE, and the DONE ones active
    in the last day (300 at most, running ones first), in id order. It is written only when that list (not `last` or
    `active`) or `bound` changes, at most every 5 s. Every device lists the `live:*` and `bound:*` keys and `updated_at` every
    5 s (one request: `or=(key.like.live:*,key.like.bound:*)`) and fetches a value only when its `updated_at` moved. A snapshot counts while its device is online (S4's `last_seen_at`
    rule, `sync-move.js` `online()`); then a conversation that device owns shows its state, name and account from it,
    and DONE when it is not listed or the device is offline. Until this device has seen that `last_seen_at` move
    (after a start, or while its own reads fail), and for a device with no `live:` row (an older Fleet View), the
    copy's own reading stands. A switch between the two readings, or to DONE because the owner went quiet, raises no
    alert; only the owner's own DONE does.
  - `prefs:<group>` (`sync-prefs.js`): the settings every device holds the same, one row per group that every device
    writes (last writer wins), sealed with `sealText(json, key, 'setting:prefs:<group>')`, `updated_at` set to its `at`:
    `{ v: 1, device, at, after, items, gone? }`. `after` is `{ by, at }` of the row the writer had agreed on when it wrote
    (null on its first write), so a reader can tell a row made without its own last write. `gone` (since 2026-10-12; left
    out when empty): the group's tombstones, `[[key, at], ...]`, a key taken out of the group and when (the clock of
    the device that took it out, noted the first round that saw it), kept 30 days, at most 500 a group, merged from
    every row a device takes (the newest of each). Groups and their items (a
    repo root `R` is `{ origin, name }`: its GitHub `owner/name` or null, and its folder's name):
    - `hidden`: `{ id, at, forgot? }` hidden and removed conversations (`settings.hidden`; `forgot: true` for the ones
      on `settings.forgotten`). `at` is when it was hidden: it shows again once it works after that.
    - `names`: `{ id, name }` Fleet View's own conversation names (`settings.names`, POST /rename); `name` null for
      one cleared by hand.
    - `moved`: `{ id, root: R | null, at }` "Move to workspace" (`settings.moved`).
    - `hiddenRepos`: `{ root: R, at }`; `repoNames`: `{ root: R, name }`; `repoOrder`: `R`, in order.
    - `addedRepos` (since 2026-10-12): `{ root: R, at }` workspaces added by hand (`settings.addedRepos`, POST /repos/add).
      One added on one machine is added on another that has a checkout of that repo, else it rides along.
    - `mapSpots`: pinned spots only (`pin: true`): `{ repo: R, x, y, pin, at? }` for a workspace's spot (`r:<root>`
      here), `{ id, x, y, pin, at? }` for any other (`s:<conversation id>`) as it is. `at` (since 2026-10-12): when the spot
      last changed on the device that changed it (`fleet-view.js` `stampSpots`). Unpinned spots stay on each machine
      (the map's spacing rule moves them to fit that screen) and are kept when the group comes in. A pinned workspace
      spot the group no longer has (unpinned or dropped on another device) stays on this machine, unpinned where it is
      (`demote`), so the page sees an unpin rather than a spot gone (which it would put back pinned).
    - `teams`: as `settings.teams` keeps them, less `seenAt` and `here` (each device its own). A team that came from
      another device and whose members this machine never listed (`here: false`) is never pruned here: the device
      that runs its members lets it go, and that reaches the others.
    - `hostRules`, `pinOverrides`: see `sync-prefs.js` (`cleanHostRule`, `cleanPinOverride`).
    - `keepPins` (since 2026-10-12): `{ repo: R, branch, at }` housekeeping's "Keep" on a GitHub branch (`housekeeping.js`
      `remotePins`, its `prefs.json` `pins` and `pinAt`). Worktrees' and local branches' pins stay on their machine.
    - `parity` (since 2026-10-12): `{ name, web, app, core }` the parity rules (`settings.parity`), one per repo name.
    - `dynamicChats` (since 2026-10-12): `{ id, model, effort, at }` a chat's Dynamic parts (`settings.dynamicChats`,
      POST /chat/dynamic), one per chat; see `sync-prefs.js` `cleanDynamicChat`.
    - `repoHues` (since 2026-10-12): `{ root: R, hue, at? }` a workspace's colour picked in Fleet View
      (`settings.repoHues`, right-click "Colour", POST /settings `repoHue`); `hue` a tone round the colour wheel (0-359),
      `at` when it was picked (a pick after a "Default" elsewhere wins). Its conversations' shades follow it.
    - `sessHues` (since 2026-10-12): `{ id, hue, at? }` a conversation's own colour (`settings.sessHues`, POST /settings
      `sessHue`), one per chat; it wins over its workspace's. "Default" takes an item out of either group.

    Never synced (each screen's own): view, zoom, the map's camera and saved views, window bounds, query, the
    workspace filter (`repo`, `repos`), `offAccounts`, `pushTargets`, bots, compact, finishedOpen, steady, notify.
    A root goes up as `{ origin, name }` and comes back as the root here with that origin (the one with that folder
    name first), else one with that folder name and no other origin; root keys compare in lower case, `\` and `/`
    alike. A path this machine does not list (stale data, another machine's path) goes up as the repo here with its
    folder name, or is left out when the repo here already has an item. Only folders that exist are roots here, and a
    root's origin, once seen, holds for the run. An item that does not translate on a machine is not put in there, but
    rides along in what that machine writes, so the machine that has the repo keeps it; one the machine already has
    under the same key stays as it is. When that repo turns up on the machine later, the item is put in there (never
    read as a delete).
    Each device keeps what it last agreed on per group (`settings.prefsSync`: `{ at, by, base, prev, ride, gone }`, and
    its device id and key's id: another one means a first join). A change here (the group's items differ from `base`;
    order counts only for `repoOrder`) lists the rows first and writes the whole group, at most every 3 s a group. A row
    whose `at` or device differs from `base`'s, written by another device, is taken: it replaces this machine's items,
    or, when this machine changed the group too, the two are merged item by item (`merge3`: what changed here wins,
    what was dropped here stays dropped) and written back, with three refinements:
    - an item changed here and taken out there stays out when the row's tombstone for it is newer than the item's own
      time (`at`; a team's newest message); one taken out here and changed there comes back when its time is past this
      device's tombstone (an unpin after a drag wins, a pin after an unpin wins). An item with no time (names,
      workspace names, rules) or no tombstone to compare (an older device's row) merges as before;
    - `teams` changed on both merge field by field: a field changed here is this device's, else the other's;
      `messages` and `successors` are both devices', one of each, in time order, the newest 50 and 10;
    - `repoOrder` changed on both (`mergeOrder`): this device's order for what both have, less what the other took out,
      with what the other put in woven in after its neighbour there. A repo that does not translate here rides along
      where it stands in the order (not at the end), so a reorder here never moves or drops it.
    When this device wrote last and the row's `after` is not that write (both wrote at once), it is merged the same way
    against `prev` (the base before that write). First join (no `base`): a device that never agreed on any group (a new
    machine, or another device id or key) takes the row (`join`): the row's items (the row's on a key both have, the
    row's order), plus its own items the row lacks, less those the row's `gone` says were taken out after the item's own
    time (or at all, for an item with no time). So a machine back with an old copy never puts back what the others
    removed, and one joining for the first time loses nothing of its own. That first join ends with the device's first
    full read of the rows: a group new to a device that already syncs others (one a newer release added) is joined as
    before: both, this machine's item winning on the same key. Apart from the tombstones, `at` is only compared for
    equality. Every device lists the `prefs:*` keys and `updated_at` every 10 s and fetches a value only when its
    `updated_at` moved (compared as times).

    **The page's ops** (POST /settings, since 2026-10-12): the page sends `hiddenReposOps`, `repoNamesOps` and
    `mapSpotsOps`, single-item changes (`{ op: 'add', ... }` puts an item in or replaces the one of the same key,
    `{ op: 'remove', ... }` takes it out; `repoOrderOps` also takes `{ op: 'move', root, before }`), worked out against
    the server's list as the page last had it, and the server applies each to its list as it is now
    (`sync-prefs.js` `applyOps`). A whole list from a page that had not polled since another device's change used to
    put that change back; ops cannot. The server stamps a map spot's `at` when it changes.

    **Compatibility** (one machine may run the older release for a while):
    - New row field `gone`, new item field `at` on map spots, and the groups `addedRepos`, `keepPins`, `parity`,
      `dynamicChats`, `repoHues`, `sessHues`: an
      older device ignores them (its `openRow` reads only `v, device, at, after, items`; its `GROUPS` has no such
      group, so it never lists or writes those rows; its `mapSpots` clean drops `at`). Its rows carry no `gone` and no
      spot `at`, and a newer device merges them as before (no tombstone to compare: what changed here wins).
    - The whole-list keys of POST /settings (`hiddenRepos`, `repoNames`, `repoOrder`, `mapSpots`) stay accepted for a
      page from an older release (a tab left open across an update reloads itself, so this is a short window). Keep
      them through two releases after this one (until 2026-11-01), then drop them from `applySettings`.
    - The live row's copy of `bound` is unchanged (still written, still read for an older device); the 7-day staleness
      applies to it too.
- **chunks** `{ conversation_id, file, generation, seq, byte_offset, byte_length, object_path, sha256 }`: one per
  object. `sha256` is the hex sha256 of the chunk's plain bytes. A whole file is `seq` 0..n of one generation (one
  chunk unless it is over 8 MiB; an empty one is a single 0-byte chunk).

## Objects (bucket `fleet-sync`, under `<user id>/`, through `sync-api.js` storage)

`object_path` = `t/<conversation id>/<b64>/<generation>/<seq>` where `<b64>` is the file key in base64url (no
padding). The body is `sealChunk(bytes, key, object_path)`: gzip, then AES-256-GCM with the path as AAD, so an object
copied to another path does not open. A chunk carries at most 8 MiB of plain bytes; a bigger addition is several
chunks.

## The uploader's rules (S2)

1. Per file it remembers `{ generation, seq, offset, tailSha }` in `<dataDir>/sync/up-state.json` (`tailSha`: sha256
   of the last up to 4096 bytes before `offset`). It is written compact, once at the end of each scan (and after a
   flush, a forget and a stop), so after a crash the server may be ahead of it: a row that disagrees is checked
   against the server's chunks and taken over, and before the first append to a file's generation in a process the
   chunk rows from the next `seq` on (and their objects) are deleted, so a `seq` sent again never leaves an old one
   after it.
2. The file grew and those bytes are unchanged: upload `[offset, size)` as the next chunk(s) of the same generation.
3. It shrank, or the tail changed, or it is a whole file that changed: `generation + 1`, upload it from byte 0 as
   `seq` 0..n. Once every chunk of the new generation is up and the conversation row points at it, delete the old
   generation's rows and objects.
4. Order, always: object, then its chunk row, then the conversation row (`size`, `sha256`, `generation`,
   `updated_at`). A reader never sees a row whose object is missing, and a conversation row never claims more than
   its chunk rows hold. The chunks' foreign key needs the conversation row first, so a new one is inserted with
   `size` 0 before any chunk and filled in last. Any file's upload (a side file too) bumps `updated_at`, so the
   materializer sees side-file-only changes.
   A new generation (and every whole file) uploads all its objects first, then inserts all its chunk rows at once,
   so a reader never sees half of one.
5. Only lines that are whole: an upload of `main` or a `.jsonl` stops at the last `\n`, so a line being written is
   never cut.
6. Newest first, a few MB/s at most, one conversation at a time; a failure backs off and retries, never loses state.
7. Only conversations this device owns (or new ones). A live conversation keeps uploading as it grows, at most
   every 45 s while a turn of it runs here (its claude busy), at once when the turn ends, and at once for a move's
   flush. A conversation the materializer's rows (below) say another device owns, while they were listed in the last
   minute, is left alone with no request; otherwise its row is asked for, as is every flush's.

## The materializer's rules (S3)

1. For every conversation row owned by another device (and `state = 'active'`; with `size` 0 the row has no `main`
   yet, and no `main` is laid down): find this device's root for its
   `repo_id` (repo_paths, or a scan of the repos Fleet View knows; for the home row, this device's home folder);
   none: skip it. Folder `X` = root + `rel_cwd` (see above; `..`, an absolute path or a drive is refused), slug of
   `X`, projects folder of `account`. Under the home row, an `X` this device does not have is made (an empty folder,
   logged once) once the log is laid down, so the conversation shows and resumes there; nothing is ever made outside
   the home folder or through a link on the way. A conversation already on this device stays where its
   log is: the slug folder it was laid down in, or any slug folder of that projects folder holding `<id>.jsonl`
   (one this device started, that another one took over). It never gets a second copy.
   A bound row needs no checkout: `X` is its placeholder here (see [Portable and bound](#portable-and-bound)), made
   empty right before its log is laid down (never through a link, nothing in its place); the device that hosted it
   (this one, after another device took the row) uses the folder `rel_cwd` names when that is still here.
   **Listing the rows.** The first scan lists every active row another device owns (every column, in pages by `id`);
   after it, a whole list of the light columns (`id, account, updated_at, owner_device, lease_until`) every 4 minutes,
   which fetches every column by `id` only for the rows it lacks or whose `updated_at` moved, and drops the rows it no
   longer lists. The scans between list only the changed rows, in any state and with any owner but this device:
   `or=(updated_at.gte.<W>,lease_until.gte.<L>)`, where `W` is the newest `updated_at` seen on another device's row
   (that writer's clock), never past this device's clock, less 2 minutes (clock skew, a write still on its way), and
   `L` the newest `lease_until` seen, never more than 3 minutes (a lease's length) past this device's clock, less the
   same. Every row change that matters moves `updated_at` (the uploader's
   row write, a new row, the mover's claim); what does not shows at the next whole list, 4 minutes at most: a change
   of account alone, a row deleted or set inactive by hand, an owner set where there was none (the uploader's claim of
   an ownerless row, written again with `updated_at` at the end of that pass), and a row this device took over (its
   own rows are never listed: the mover keeps its claim until a whole list began after it, and a pull reads the row
   itself). A row a pull read while a list was under way stays as the pull read it until the next list (the list's
   copy may be the older one). No trigger is needed.
2. Read its chunk rows (in pages of 1000, PostgREST's cap: each page starts on the last row of the one before, and a
   different row there starts the listing again) for the current generation, ordered by `seq`; check they cover `[0, size)` with no gap; fetch
   and open each, check each `sha256`, then the whole file's against the conversation row.
   When `main`'s generation is the one laid down and the files laid down are still here as they were (their size and
   modified time right after they were laid down), only the rows past them are read: `and=(not.and(file.eq."<file>",
   generation.eq.<g>,seq.lt.<n>),...)`, one clause per file laid down (main first, then the ones with most chunks,
   while the filter stays under 3000 characters; percent-encoded it is about 4 KB). The new chunks go behind the bytes
   here, which are checked against their sha256 first, and the whole file against the row as above. A new generation
   of a known side file, a gap, local bytes that are not the ones laid down, or a sha256 that does not match the bytes
   put together read every row again; so does a filter a proxy on the way finds too long (414 or 431, that time
   only), and one Supabase refuses (400, from then on).
3. Lay it down per the recipe: write `<id>.jsonl.part`, rename. If a local copy exists, replace it only when it is a
   byte prefix of the new file; if it is longer or different, leave it, write nothing, and report a conflict. A local
   `.jsonl` whose last line was cut off (its writer ended mid-line, so that part never went up, rule 5 above) counts
   by its whole lines: the new bytes replace the cut line.
4. Side files the same way, under `<slug>/<id>/`.
5. Never touch a conversation that is running on this machine (the session host or a live Claude process has it open).
6. Remember what it laid down (`<dataDir>/sync/down-state.json`, compact, written once a scan and after a pull, a
   move and a stop; per file its generation, size, sha256, chunk count and size and modified time), so an unchanged
   row costs one cheap compare, unless its log is gone from here (Claude Code's cleanup): then it is laid down again.

## Moving a conversation (S4)

`sync-move.js` moves `owner_device` from A (the device that has it) to B (the device that asks), with no lost line and
no fork; its header has the whole order. What it adds to the rows:

- **Two settings rows per move**, each written by one side only, sealed with `sealText(json, key, 'setting:<key>')`:
  - `move:<id>:ask` (B's): `{ v: 1, id, to: B, from: A, at, nonce, force }`. B writes `at` again every 20 s while it
    waits.
  - `move:<id>:reply` (A's): `{ v: 1, id, nonce, from: A, at, phase, note, status?, waitingFor?, external?, final? }`,
    `phase` one of `asked`, `waiting`, `ending`, `uploading`, `released`, `failed`; `final` `{ size, sha256,
    generation }` comes with `released`. A writes `at` again every 10 s.

  Each side judges the other's row fresh by seeing its `at` change on its own clock, never by comparing two clocks. B
  deletes both rows when its job ends; A deletes its reply when the ask goes away.
- **The claim**: B's `PATCH conversations?id=eq.<id>&owner_device=eq.<A>&sha256=eq.<sha256>` sets `owner_device` to B
  and `lease_until`. The sha256 is A's `final` (or, for a forced takeover, the row B just laid down). A line A writes
  after it let go makes the claim fail; ownership never moves any other way.
- **`lease_until`**: the owner puts it 3 minutes ahead every 60 s on the conversations it runs in its session host
  (one PATCH, conditional on `owner_device` = itself), and a claim sets it. A forced takeover (A offline or not
  answering) waits while it is ahead, and after one the new owner's uploader stays held 30 s, then takes over what the
  server has, so a chunk A still had on its way never replaces one the new owner wrote. What the server has can be
  behind A's log: mid-turn, A's uploader sends a chat at most every 45 s (the uploader's rule 7), so a forced takeover
  of a chat A went offline in mid-turn can lack up to that turn's last 45 s.
- **`devices.last_seen_at`**: the mover touches it every 30 s. Another device counts it offline when it sees the value
  unchanged for 2 minutes on its own clock.

## Portable and bound

Every conversation's workspace is one of two kinds (`sync-common.js` "portable or bound"; `sync-work.js` `inspect()`
uses the same rule and the same words):

- **Portable:** a git checkout whose origin normalizes (every machine has it, or can clone it), or a folder under the
  home folder in no git checkout (a scratchpad, a bot's folder).
- **Bound:** everything else, which only the machine it is on has: a git checkout with no origin (wherever it is:
  its commits have nowhere to be fetched from), a folder outside the home folder, the home folder itself, an app data
  or Claude account folder, a Perforce workspace (a `.p4config`, `p4config.txt`, `.p4config.txt` or `.p4ignore` file,
  or the file `P4CONFIG` names, in the folder or above it; the client root `p4 info` gives; or a folder under
  `~/Perforce`, P4V's default), and a placeholder (below).

Which row a conversation goes under is the uploader's rule (above), and it did not change for the ones synced before:
a checkout with no origin, a Perforce workspace or the home folder itself under the home folder still go under the
home row. The ones never synced before go under their device's bound row: a folder outside the home folder (a git
repo with no origin there too), and `AppData` or `Library` under it. Never: the temp folder (`os.tmpdir()`, and
`/tmp` and `/var/folders` on a Mac: a script's or a test's), a Claude account's own folder (`~/.claude-<letter>`), or
Fleet View's data folder (a tool's chats).

**The placeholder.** Another device lays a bound conversation down in a folder Fleet View owns:
`<home>/.fleet-view/bound/<host's name>/<hash>/<folder name>` (`sync-common.js` `boundPlaceholder`): the host's
device name and the folder's last name made safe for a folder, and the first 8 hex of the sha256 of `rel_cwd`, so two
folders of one name (or two paths whose slugs would match) never share one. It is made empty, before the log, and is
never a checkout. The conversation is the host's like any row another device owns: in `away.json`, never opened here
as this machine's own. **Continue here anyway** (S4) moves it into the placeholder: its files stay on the host. A
conversation resumed in a placeholder is bound to the device it runs on, whatever holds the folder.

**What each machine says.** `/state` gives every conversation `workspace: { kind: 'portable' | 'bound', host: {
device, name } | null }` (`host` null when this machine runs it). For one another device runs: bound when its row is a
bound one, or when that device's `live:` row lists it in `bound` (only it can tell a checkout with no origin under its
home folder, which goes under the home row); a placeholder here is bound; else portable. For one this machine runs:
its folder's kind, read at once (`fleet-view.js` `workspaceOf`, the facts from `sync-common.js` `checkoutAt` and
`perforceAt`).

## The work pack

What `sync-work.js` gives for the code a chat was changing (docs/sync-follow.md, item 3), and how a move carries it
(`sync-move.js` with `sync-carry.js`; see "What a move carries" below).

- **The manifest** (plain JSON):

  ```
  { v: 1, kind: 'git' | 'plain', origin, branch, head, base, bundle, bundleRef, staged, unstaged,
    trees: { index, work }, untracked: [{ path, mode, size, sha256 }], env: [path], rel, worktree,
    summary: { commits, files, bytes }, notes: [text] }
  ```

  - `origin`: `normalizeOrigin`'s string, as the repos row has it (`home:` for a plain folder). `branch`: null when
    detached. `head`: the commit. `base`: where the work leaves the origin's branch (merge-base), or null.
  - `bundle`: a git bundle of the commits no `refs/remotes/origin/*` has, its tip `bundleRef`
    (`refs/heads/<branch>`, or `HEAD` when detached), or null when origin has them all.
  - `staged`, `unstaged`: `git diff --cached` and `git diff`, binary, full index, renames found, `a/` `b/` prefixes,
    no external diff or textconv; null when empty.
  - `trees`: the tree ids of the index and of the working tree's tracked files as git sees them (after its clean
    filters, so CRLF on Windows and LF on the Mac compare equal). The target checks these, not the diffs' bytes.
  - `untracked`: the files git doesn't track and doesn't ignore. Paths use `/`. `mode` is `100644`, `100755` or
    `120000` (a symlink, whose blob is its target). Never a file or folder named `.env` or `.env.*`, in any case:
    those are only named in `env`, and their contents travel as secrets (item 4). A folder that is a git repository
    of its own isn't carried (named in `notes`).
  - `rel`: the chat's folder from the checkout's top (or from the home folder, for plain). `worktree`: the linked
    worktree's folder name, so the target makes its own with the same name.
- **Blobs**: the bundle, both diffs and every untracked file, each named by the sha256 of its bytes (lower-case hex),
  so a blob that two entries share is carried once and a changed or missing blob is found before anything is written.
- **Kinds**: `git` for a checkout whose origin normalizes; `plain` for a folder under the home folder in no checkout
  (the home row): every file in it but `node_modules`, `.git` and env files, at most 20,000. Nothing else is packed:
  a checkout with no origin, a folder outside home, the home folder itself, an app data or Claude account folder,
  or a Perforce workspace stays on its machine.
- **Caps and refusals**: 200 MB in all; a checkout with no commit; a merge, rebase, cherry-pick or revert under way; a
  changed submodule; a changed or new git-lfs file.
- **Laying it down** (`unpack`): in the target checkout of the same origin, after `git fetch origin` (offline only
  makes a note) and the bundle into `refs/fleet-view/incoming/<head>`, in the chat's own worktree
  (`<checkout>/.claude/worktrees/<name>`) or a clean checkout used in place. It never loses a commit, never touches a
  dirty checkout, and never moves a branch another worktree has checked out. Then it verifies, and undoes what it
  made if verification fails.
- **Putting it away** (`putAway`): the source's `git stash push --include-untracked`, env files left in place.
  Nothing is deleted.

### What a move carries (sync-carry.js)

- **In storage** (the fleet-sync bucket, under the user's folder; every object gzipped and sealed with
  `sync-crypto.js` `sealChunk`, its label its path):
  - `w/<conversation id>/b/<blob sha256>/<n>`: a blob's n-th piece of at most 8 MiB. A conversation keeps each blob
    once, whatever packs name it.
  - `w/<conversation id>/p/<pack id>`: a pack's record, `{ v: 1, id, manifest, blobs: { <sha256>: size } }`. Pack ids
    are 16 hex digits.
- **The list** of a conversation's packs: the settings row `work:<conversation id>`, sealed like the move rows:
  `{ v: 1, id, packs: [{ pack, kind: 'move' | 'snapshot', by (device), at, record (sha256 of the record's JSON),
  blobs: { <sha256>: size }, summary, sig? }] }`. A move's pack goes once the new owner laid it down (or after a day,
  its move failed); snapshots are kept 3 to a conversation; a blob goes when no pack left names it.
- **The move** (`move:<id>:ask` and `:reply`, above): an ask with `carry: 1` (B lays packs down; an older B never
  says so, and A then packs nothing) and `noWork: true` (Henry's "Move it without the work"). A's released reply's
  `final.work`: `{ pack, record, kind, branch, summary, notes, shared, envPaths }` (`shared`: another live chat on A
  works in that checkout, so A leaves the changes there too; `envPaths`: the env files' paths, from the checkout's
  top, ignored ones included), or `{ none: why }` (a bound folder; an older B) or `{ refused: why }` (noWork). A pack
  sync-work.js refuses without noWork fails the reply, with `workRefused: true`.
- **On B**, before the claim: the pack laid down (`unpack`: the chat's own worktree, or in place where it began when
  that checkout is on its branch, clean, and no other live chat there works in it), the log moved into the slug
  folder of the folder it resumes in (`relocateLog`; the materializer's `moved(id, dir)` keeps it there), the env
  files and sign-ins from A over the link (`/peer/env`, `/peer/logins`: never Supabase), and the ready check. Any
  failure fails the job: nothing is claimed, and what was laid down goes again. After the claim: the note for Claude
  (`<dataDir>/sync/notes.json`, `GET`/`POST /sync/note`), the move's pack dropped, the dependencies installed in
  the background by the lockfile (`<dataDir>/carry.log`). On A, once it sees B's claim: `putAway`, a stash named
  "fleet-view: moved to <B> <time> (<id>)", unless another live chat there works in that checkout.
- **Snapshots**: at the end of each turn of a portable chat a device hosts and owns (busy, then idle), a pack of its
  work when it changed since the last one (HEAD, `git status`, and the listed files' sizes and times; a plain
  folder's files' sizes and times). A forced takeover while the owner is off lays the owner's newest snapshot down,
  and the note says how old it is.

## Done means

S2: 50 random real conversations uploaded, downloaded by S3 into a temp projects folder, byte-identical (main and
side files). S3: a PC conversation resumes in a second checkout with the session host's `open` op. S4: one
conversation moves three times between two devices with no lost line and no fork.
