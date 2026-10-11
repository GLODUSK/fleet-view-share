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
  `Library` or `.claude-<letter>` folder (`homeSkipped`), and in no repo with an origin: not synced. Nor while a
  `.git` above the folder is one git could not read (a time-out, no git): it waits for git, never the home row. Down
  here, a folder `homeSkipped` names, or one where a file sits, is never made: the home folder itself stands in.
- **repo_paths** `{ device_id, repo_id, root }`: where this device has a checkout of that repo (the main checkout's
  top-level folder, `git rev-parse --show-toplevel`). Written by whichever side finds it. For the home row, `root` is
  that device's home folder (`os.homedir()`: `C:\Users\henry` on one, `/Users/henry` on another).
- **conversations** `{ id, account, repo_id, rel_cwd, branch, title_enc, state, owner_device, lease_until, size,
  sha256, generation, updated_at }`:
  - `account`: `a` or `b` (the Claude account whose projects folder holds it).
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
  - `branch`: the last `gitBranch` in the log, plain text.
  - `title_enc`: `sealText(title, key, 'title:<id>')`, the last `custom-title` (or `summary`) line's title.
  - `size`, `sha256`, `generation`: the `main` file's uploaded length, the hex sha256 of those bytes, its generation.
  - `owner_device`: the device that writes it. S2 sets itself on a new row and only uploads rows it owns (or with no
    owner). S4 moves it. `lease_until` is S4's (below).
- **settings** `{ key, value_enc }`: one row per key, upserted on `(user_id, key)`. S4's request rows are the only ones
  so far (below).
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
   of the last up to 4096 bytes before `offset`).
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
7. Only conversations this device owns (or new ones). A live conversation keeps uploading as it grows.

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
2. Read its chunk rows for the current generation, ordered by `seq`; check they cover `[0, size)` with no gap; fetch
   and open each, check each `sha256`, then the whole file's against the conversation row.
3. Lay it down per the recipe: write `<id>.jsonl.part`, rename. If a local copy exists, replace it only when it is a
   byte prefix of the new file; if it is longer or different, leave it, write nothing, and report a conflict. A local
   `.jsonl` whose last line was cut off (its writer ended mid-line, so that part never went up, rule 5 above) counts
   by its whole lines: the new bytes replace the cut line.
4. Side files the same way, under `<slug>/<id>/`.
5. Never touch a conversation that is running on this machine (the session host or a live Claude process has it open).
6. Remember what it laid down (`<dataDir>/sync/down-state.json`), so an unchanged row costs one cheap compare.

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
  server has, so a chunk A still had on its way never replaces one the new owner wrote.
- **`devices.last_seen_at`**: the mover touches it every 30 s. Another device counts it offline when it sees the value
  unchanged for 2 minutes on its own clock.

## Done means

S2: 50 random real conversations uploaded, downloaded by S3 into a temp projects folder, byte-identical (main and
side files). S3: a PC conversation resumes in a second checkout with the session host's `open` op. S4: one
conversation moves three times between two devices with no lost line and no fork.
