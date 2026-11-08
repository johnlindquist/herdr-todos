# Todos and Memories for Herdr

A right-hand sidebar for the Herdr desktop app, in two halves:

- **Todos** (top): the task lists of the Pi sessions in the space you're looking at, kept up to date.
- **Memories** (bottom): rules worth keeping that you stated in your own prompts. Keep one and the
  project's `MEMORIES.md` (linked from `AGENTS.md`) is rewritten to include it; dismiss it and it
  isn't suggested again.

- **Sessions with a `todo` board** (the `todo` tool from herdr-pi-todos) show that board exactly.
- **Other sessions** are summarized by Haiku (`anthropic/claude-haiku-4-5` through `pi -p`) each
  time the session's journal changes: when a reply finishes, when a new prompt starts, and at most
  every two minutes while it keeps working.
- **Every space is cached** in `~/.cache/herdr-todos/default/`, so switching spaces shows the
  last lists at once and then updates them. When the sidebar starts, it reads every space that has
  a Pi session in the background, one after another.
- **Spaces on other machines** are read on that machine: the helper is piped through herdr-core
  (`hc exec --on <machine> -i node`) so the machine's own journals, git roots and Pi login are used,
  and kept memories are written into that machine's project. It needs Node and Pi there; without
  them the panel says so. Its state lives in that machine's `~/.cache/herdr-todos/remote/`.

## Use it

- **Click a card** to go to that session. If you're zoomed in, the clicked pane is zoomed instead,
  so the view actually changes.
- **Drag a card** onto another to reorder. Your order comes first; sessions you haven't placed
  follow, sorted by urgency (needs you, working, done).
- **Flag a task**: hover a task and click the flag. Each click moves it from normal to high, then
  low, then back to normal. High tasks are bold, sort first within their group and are never
  folded into "+N more". Low tasks are dimmed and sort last. Haiku keeps a flagged task's wording
  so the flag stays attached.
- The refresh button (top right) re-reads the space and asks Haiku again for every session.

## Memories

While Todos updates, each session's new prompts (and the reply each one reacts to) go to Haiku with
one question: did the person state a rule for future work here? A decision ("the approved
recording is the source of truth"), a preference ("support light and dark mode") or a correction of
the agent. Feature requests and task descriptions are dropped, and most prompts produce nothing.
A session seen for the first time contributes only its latest two prompts.

- **Keep**, **Edit** (in the editor, Keep saves your wording) and removing a kept line each
  rewrite `<project>/MEMORIES.md` from all kept memories: overlapping ones merge, related ones
  group under short headings (only when there are several), and each line becomes
  `- **Label:** rule` in as few words as keep its meaning. Sonnet (`anthropic/claude-sonnet-5-5`,
  override with `HERDR_TODOS_COMPOSE_MODEL`) does the rewrite; code checks that every kept memory
  is still in the file before writing it, and falls back to Haiku, then to the plain list.
- The first Keep adds one line to `<project>/AGENTS.md`:
  `Read [MEMORIES.md](MEMORIES.md) first: standing decisions for this project.` AGENTS.md is created
  if the project has none. An older `memories.md` is renamed and its link updated.
- **Dismiss** hides a suggestion and tells future suggestions not to propose it again. **Undo**
  brings it back.
- **Kept in MEMORIES.md** lists the file's lines; ✕ removes a line (all memories merged into it).
- Hand edits to MEMORIES.md are kept: a deleted line removes its memories, a new line becomes a
  kept memory, and both show in the next rewrite.

Sessions outside a git repository don't produce suggestions.

## Install

```sh
./install.sh        # copies both mods into ~/.config/herdr-app/mods and checks them
./dev-reload.sh     # same, then restarts the shown copy (when hot reload misses a change)
```

The first install docks Todos on the right of the layout you're using. Memories has no dock spot
of its own; put it under Todos with a column in the layout. Drag the line between them to resize;
each half scrolls on its own and keeps at least its `min` height:

```json
{ "id": "right-panel", "type": "column", "size": { "px": 304 }, "divider": { "width": 1, "color": "border" },
  "children": [
    { "type": "block", "content": { "mod": "todos" }, "size": { "weight": 3 }, "min": 140 },
    { "id": "memories", "type": "block", "content": { "mod": "memories" }, "size": { "weight": 2 }, "min": 120 } ] }
```

## For agents

`todos.mjs` (Node 22+) is the whole interface; the sidebar calls it too.

```sh
node todos.mjs describe
node todos.mjs show     --space <id> --state ~/.cache/herdr-todos/default
node todos.mjs refresh  --space <id> --state ~/.cache/herdr-todos/default [--force]
node todos.mjs order    --space <id> --state ... --terminals t8r,t90
node todos.mjs priority --space <id> --state ... --terminal t8r --task '#2' --level high
node todos.mjs memories --space <id> --state ...            # or --root <project folder>
node todos.mjs memory accept|dismiss|edit|remove|restore --root <folder> --id <id> [--text <words>] --state ...
node todos.mjs memory add --root <folder> --text "<rule>" --state ...
```

Space ids come from `herdr-app status` or `hc get <terminal>` (label `herdr.space`). Task keys
are in each task's `key`. The sidebar takes changes made this way on its next update. Output is
one JSON document; errors are JSON on stderr with exit 1. `state` is `ready`, `empty` (no Pi
sessions) or `missing` (never read); `busy: true` means another refresh holds the space.

## How a terminal is matched to its Pi session

1. A `pi.session=<journal path>` label on the terminal, if something sets one.
2. The session name Pi reports to Herdr (or puts in the terminal title while idle), matched
   against `session_info` names in the journals of Pi's folder for that working directory, then
   in Pi's other recent folders (a session started before a `cd` or a folder rename).
3. The journal used last time by the same Pi process.
4. The newest unclaimed journal in that folder.

`mapping` in the output says which one was used. Sub-agents (terminals with a parent) aren't
listed. Pi terminals whose Pi has exited drop out after the next update.

## Models

- `HERDR_TODOS_MODEL`: task lists and memory suggestions (default `anthropic/claude-haiku-4-5`).
- `HERDR_TODOS_COMPOSE_MODEL`: the MEMORIES.md rewrite (default `anthropic/claude-sonnet-5-5`).
- `HERDR_TODOS_MODEL_CMD`: a JSON array such as `["node","my-model.mjs"]`, run instead of Pi for
  every model call. It gets `{"model","system","input"}` as JSON on stdin and prints the reply.
  Use it to try other providers, or a recorded or test model.

## Cost

One Haiku call per changed session for its tasks (about 4–6k input tokens), and one per batch of new
prompts for memories (usually under 2k). Unchanged sessions are never sent.
