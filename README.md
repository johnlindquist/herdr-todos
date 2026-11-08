# Todos for Herdr

A right-hand sidebar for the Herdr desktop app. It lists the task lists of the Pi sessions in the
space you're looking at and updates them by itself.

- **Sessions with a `todo` board** (the `todo` tool from herdr-pi-todos) show that board exactly.
- **Other sessions** are summarized by Haiku (`anthropic/claude-haiku-4-5` through `pi -p`) each
  time the session's journal changes: when a reply finishes, when a new prompt starts, and at most
  every two minutes while it keeps working.
- **Every space is cached** in `~/.cache/herdr-todos/default/`, so switching spaces shows the
  last lists at once and then updates them. When the sidebar starts, it reads every space that has
  a Pi session in the background, one after another.
- Remote spaces aren't read.

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

## Install

```sh
./install.sh        # copies into ~/.config/herdr-app/mods/todos and checks it
./dev-reload.sh     # same, then restarts the shown copy (when hot reload misses a change)
```

The first install docks the sidebar on the right of the layout you're using.

## For agents

`todos.mjs` (Node 22+) is the whole interface; the sidebar calls it too.

```sh
node todos.mjs describe
node todos.mjs show     --space <id> --state ~/.cache/herdr-todos/default
node todos.mjs refresh  --space <id> --state ~/.cache/herdr-todos/default [--force]
node todos.mjs order    --space <id> --state ... --terminals t8r,t90
node todos.mjs priority --space <id> --state ... --terminal t8r --task '#2' --level high
```

Space ids come from `herdr-app status` or `hc get <terminal>` (label `herdr.space`). Task keys
are in each task's `key`. The sidebar takes changes made this way on its next update. Output is
one JSON document; errors are JSON on stderr with exit 1. `state` is `ready`, `empty` (no Pi
sessions) or `missing` (never read); `busy: true` means another refresh holds the space.

## How a terminal is matched to its Pi session

1. A `pi.session=<journal path>` label on the terminal, if something sets one.
2. The session name Pi reports to Herdr, matched against `session_info` names in the journals
   of Pi's folder for that working directory.
3. The journal used last time by the same Pi process.
4. The newest unclaimed journal in that folder.

`mapping` in the output says which one was used. Sub-agents (terminals with a parent) aren't
listed. Pi terminals whose Pi has exited drop out after the next update.

## Cost

One Haiku call per changed session, about 4–6k input tokens. Unchanged sessions are never sent.
