# Sync: what goes up, and how it comes back (the S2/S3 contract)

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
  updates `last_seen_at` at most every 5 minutes.
- **repos** `{ id, origin }`: one per GitHub repo, `origin` normalized: `https://github.com/<owner>/<repo>` in lower
  case, from `git remote get-url origin` (ssh `git@github.com:o/r.git`, `https://user@github.com/o/r.git` and
  `.../o/r/` all become the same string). Other hosts: `https://<host>/<path>` the same way. No origin: not synced.
- **repo_paths** `{ device_id, repo_id, root }`: where this device has a checkout of that repo (the main checkout's
  top-level folder, `git rev-parse --show-toplevel`). Written by whichever side finds it.
- **conversations** `{ id, account, repo_id, rel_cwd, branch, title_enc, state, owner_device, lease_until, size,
  sha256, generation, updated_at }`:
  - `account`: `a` or `b` (the Claude account whose projects folder holds it).
  - `rel_cwd`: the conversation's last `cwd` relative to its repo root, with `/`, `''` for the root. A conversation
    in a worktree (`<root>/.claude/worktrees/<name>`) keeps that path as its `rel_cwd`; S3 lays it down in the main
    checkout's slug folder for that path only if that folder exists on the device, else in the root's.
  - `branch`: the last `gitBranch` in the log, plain text.
  - `title_enc`: `sealText(title, key, 'title:<id>')`, the last `custom-title` (or `summary`) line's title.
  - `size`, `sha256`, `generation`: the `main` file's uploaded length, the hex sha256 of those bytes, its generation.
  - `owner_device`: the device that writes it. S2 sets itself on a new row and only uploads rows it owns (or with no
    owner). S4 moves it. `lease_until` is S4's.
- **chunks** `{ conversation_id, file, generation, seq, byte_offset, byte_length, object_path, sha256 }`: one per
  object. `sha256` is the hex sha256 of the chunk's plain bytes. For whole files, one chunk with `seq` 0 per
  generation.

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
   its chunk rows hold.
5. Only lines that are whole: an upload of `main` or a `.jsonl` stops at the last `\n`, so a line being written is
   never cut.
6. Newest first, a few MB/s at most, one conversation at a time; a failure backs off and retries, never loses state.
7. Only conversations this device owns (or new ones). A live conversation keeps uploading as it grows.

## The materializer's rules (S3)

1. For every conversation row owned by another device (and `state = 'active'`): find this device's root for its
   `repo_id` (repo_paths, or a scan of the repos Fleet View knows); none: skip it. Folder `X` = root + `rel_cwd`
   (see above), slug of `X`, projects folder of `account`.
2. Read its chunk rows for the current generation, ordered by `seq`; check they cover `[0, size)` with no gap; fetch
   and open each, check each `sha256`, then the whole file's against the conversation row.
3. Lay it down per the recipe: write `<id>.jsonl.part`, rename. If a local copy exists, replace it only when it is a
   byte prefix of the new file; if it is longer or different, leave it, write nothing, and report a conflict.
4. Side files the same way, under `<slug>/<id>/`.
5. Never touch a conversation that is running on this machine (the session host or a live Claude process has it open).
6. Remember what it laid down (`<dataDir>/sync/down-state.json`), so an unchanged row costs one cheap compare.

## Done means

S2: 50 random real conversations uploaded, downloaded by S3 into a temp projects folder, byte-identical (main and
side files). S3: a PC conversation resumes in a second checkout with the session host's `open` op.
