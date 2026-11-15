# Herdr Todos and Memories

Two sidebar widgets for the [Herdr](https://herdr.dev/) desktop app, in one repository:

- **Todos** watches every [Pi](https://pi.dev/) conversation in the space you are looking at. A small, fast model reads each one and shows what it is doing, what is done and what is waiting on you. You never update it by hand.
- **Memories** sits under Todos. It reads the prompts you type, suggests rules worth keeping ("keep all money in integer cents"), and writes the ones you **Keep** to the project's `MEMORIES.md`, linked from `AGENTS.md`. It only suggests; nothing is saved until you say so.

These are John Lindquist's own widgets from MEGA.dev S04E02 (Week 4, Day 2), where a widget is "an intelligent visualization of critical information": plain code gathers, a model judges. The lesson teaches you to build your own; this repository is the finished Herdr version, kept in step with the video so you can compare.

| Folder | Widget |
|---|---|
| the repository root | **Todos**, and `todos.mjs`, the helper both widgets use |
| `memories/` | **Memories** |
| `menu/` | the right-click menu both open |

## Requirements

| You need | Why | Without it |
|---|---|---|
| The [Herdr](https://github.com/herdrdev/herdr-app) desktop app with its command-line tools `herdr-app` and `hc` on your `PATH` (checked on Herdr 0.1.14) | The widgets are Herdr mods; `hc` lists the terminals of a space | `./install.sh` stops with "herdr-app was not found on your PATH" |
| [Pi](https://github.com/earendil-works/pi) on your `PATH`, logged in (checked on 1.5.0) | The widgets read Pi's conversations, and call the model through `pi -p` | A card says "Not updated:" and why |
| [Node](https://nodejs.org/) 22 or newer (checked on 25.2.1) | The helper `todos.mjs` runs on Node | `./install.sh` stops with "node was not found on your PATH" |
| A git repository for Memories | `MEMORIES.md` is written at the repository's root | Memories says "No project here yet." |
| macOS | The only system this was checked on | Unverified |

Only Pi conversations are read. A pane running another harness is not listed.

### Models and cost

| Job | Default model | Change it with |
|---|---|---|
| Task lists and memory suggestions | `anthropic/claude-haiku-4-5` | `model` |
| Rewriting `MEMORIES.md` when you keep, edit or remove a memory | `anthropic/claude-sonnet-5-5` | `compose_model` |

Any id from `pi --list-models` works. Put your choice in `~/.config/herdr-todos/config.json`:

```json
{ "model": "anthropic/claude-haiku-4-5", "compose_model": "anthropic/claude-sonnet-5-5" }
```

The widgets pick it up on their next update. Cost, roughly: one small-model call each time a conversation changes (about 4,000 to 6,000 tokens in, a few hundred out, well under one cent on the default), one smaller call for each batch of new prompts, and one call to the larger model each time you keep, edit or remove a memory. A conversation that has not changed is never sent again.

## Install

```sh
git clone https://github.com/johnlindquist/herdr-todos
cd herdr-todos
./install.sh
```

`install.sh` copies three mods into `~/.config/herdr-app/mods` (`todos`, `memories`, `todos-menu`) and runs `herdr-app check` on each. You should see three lines that start with `check passed:`. Set `HERDR_APP_HOME` first to install into another Herdr home.

Herdr docks **Todos** on the right the first time it sees the mod. Then put **Memories** under it:

```sh
node place-memories.mjs
```

This edits the layout the window shows now: the Todos block becomes a column with Memories below it, and the file as it was is saved beside it as `<layout>.json.before-memories`. Run it on a layout of your own; Herdr replaces its shipped layouts on every start, so if you are on one, make a copy first with `herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`. You can also pass a layout file: `node place-memories.mjs ~/.config/herdr-app/layouts/my-layout.json`. To do it by hand, replace the Todos block in the layout file with:

```json
{ "id": "right-panel", "type": "column", "size": { "px": 304 }, "divider": { "width": 1, "color": "border" },
  "children": [
    { "type": "block", "content": { "mod": "todos" }, "size": { "weight": 3 }, "min": 140 },
    { "id": "memories", "type": "block", "content": { "mod": "memories" }, "size": { "weight": 2 }, "min": 120 } ] }
```

- Update: `git pull`, then `./install.sh` again.
- Remove: delete the three folders from `~/.config/herdr-app/mods` and the two blocks from your layout file.

## Walkthrough, in the video's order

Do this in a Herdr space with Pi running in a pane, inside a git repository. The sample project of the lesson is [RentAPlace](https://github.com/johnlindquist/rentaplace). The model's wording will differ on your machine.

1. **Look at Todos.** Each Pi conversation in the space you are looking at is one card: a coloured dot for its state, its title, one line saying what it is doing now, and its tasks. With no Pi in the space it says "No Pi sessions in this space" and "Start Pi in a tab here. Its tasks show up after the first reply."
2. **Ask Pi for something with a few steps**, for example: *"Give me a three-step plan to add a cleaning fee to the booking total. Do not edit yet. Ask me whether it is per stay or per night."* When the reply finishes, the card fills in. In the check for this page the card read *"Plan confirmed. Ready to implement per-stay cleaning fee in pricing logic."* with three tasks, one per file to change.
3. **See what is waiting on you.** A conversation that is blocked on your answer gets a **Needs you** pill and sorts to the top. A working one has a pulsing dot. Finished tasks are ticked.
4. **Do nothing.** The card follows the conversation: it is read again when a reply finishes, when you send a new prompt, and at most every two minutes while the agent keeps working. The footer says "Updated just now" and names the model.
5. **Switch spaces.** Todos shows the conversations of the space in front of you. Every space's last list is saved, so it appears at once and then updates.
6. **Look at Memories, under Todos.** Before you have stated a rule it says "Nothing to review. Rules you state in your prompts show up here to keep or dismiss."
7. **Type a prompt that states a rule**, for example: *"Keep all money in integer cents, never floats."* After the next update a suggestion appears, labelled **Decision**, **Preference** or **Correction**, with three buttons: **Keep**, **Edit**, **Dismiss**. Feature requests and task descriptions are not suggested, and most prompts produce nothing.
8. **Click Keep, or select the suggestion and press Enter.** The line is written to `MEMORIES.md` at the root of the project, and it moves under **Kept in MEMORIES.md**. In the check for this page the file read:

   ```markdown
   # Memories

   Standing decisions for this project. A request can override them.

   - **Money:** Store money as integer cents; never floats
   ```

9. **Open `AGENTS.md`.** The first Keep added one line at the end, so every new conversation in this repository starts with your memories:

   ```markdown
   Read [MEMORIES.md](MEMORIES.md) first: standing decisions for this project.
   ```

10. **Leave the rest for later.** Suggestions wait in the sidebar; nothing is added to your conversation and nothing is saved on its own. **Dismiss** hides one and it is not suggested again; **Undo** brings it back.

### What you should see

- Todos on the right edge of the window, Memories under it, a line between them you can drag.
- In Todos: one card per Pi conversation of this space, with a title, a "now" line and tasks. No card for other harnesses or for sub-agents.
- In Memories: suggestions with **Keep**, **Edit** and **Dismiss**, then the list **Kept in MEMORIES.md**.
- In the project, only after a Keep: `MEMORIES.md`, and one new line in `AGENTS.md` (created if the project had none).

### Keys

Click inside a widget to give it the keyboard, or move to it the way you move between panes. Its keys are listed along its bottom edge while it has the keyboard, and every button's tooltip names its key.

| Key | Todos | Memories |
|---|---|---|
| **↑ ↓** or **k j** | Select a card | Select a suggestion or a kept line |
| **Enter** | Go to that conversation | **Keep** the suggestion |
| **E** | | Edit the wording |
| **D** | | Dismiss the suggestion, or remove the kept line |
| **R** | Update now | |
| **Shift+F10**, or right-click | More actions | More actions |
| **Tab**, **Shift+Tab** | Next or previous widget | the same |
| **−** | Collapse to one line, or expand | the same |
| **Esc** | Back to the conversation you came from | the same |

## More than the video shows

**In Todos**

- **Click a card** to go to that conversation. If you are zoomed in, the clicked pane is zoomed instead, so the view changes.
- **Drag a card** onto another to reorder. Your order comes first; conversations you have not placed follow, sorted by urgency (needs you, working, done).
- **Flag a task:** hover it and click the flag. Each click moves it from normal to high, then low, then back. High tasks are bold and sort first; low tasks are dimmed and sort last.
- **A conversation with a `todo` board** (the `todo` tool from [herdr-pi-todos](https://github.com/johnlindquist/herdr-pi-todos)) shows that board exactly, with no model call.
- The refresh button (top right) reads the space again and asks the model again for every conversation.

**In Memories**

- **Keep**, **Edit** and removing a kept line each rewrite `MEMORIES.md` from all kept memories: overlapping ones merge, related ones group under short headings, and each becomes `- **Label:** rule` in as few words as keep its meaning. Code checks that every kept memory is still in the file before writing it; if the larger model fails, the small one is tried, then the plain list.
- **Edit `MEMORIES.md` by hand** and it is respected: a deleted line removes its memories, a new line becomes a kept memory.
- A conversation seen for the first time contributes only its latest two prompts.

**Right-click**

- **A task:** Explain this task, Go to session, and the two other priority levels.
- **A card:** Explain where it stands, Go to session, Move to top, Update now.
- **A suggestion:** Explain where it came from, Keep, Edit, Dismiss, Go to its session.
- **A kept line:** Explain where it came from, Edit wording, Remove.

**Explain** opens a new Pi to the right of the conversation's pane. It is a fork of that conversation (`pi --fork`): it starts with the whole history, while the original keeps going on its own. Its first message asks Pi to explain the task, conversation or memory, then wait for you. The message also lists the commands that change the sidebar, so you can say "keep it, but shorter".

**Spaces on other machines** are read on that machine: the helper is sent through `hc exec --on <machine>` to that machine's Node, so its conversations, its Pi login and its projects are used. It needs Node and Pi there.

**For agents.** `todos.mjs` is the whole interface; the widgets call it too. Output is one JSON document; errors are JSON on stderr with exit 1.

```sh
node todos.mjs describe
node todos.mjs show     --space <id>
node todos.mjs refresh  --space <id> [--force]
node todos.mjs order    --space <id> --terminals t8r,t90
node todos.mjs priority --space <id> --terminal t8r --task '<task key>' --level high
node todos.mjs memories --space <id>            # or --root <project folder>
node todos.mjs memory accept|dismiss|edit|remove|restore --root <folder> --id <id> [--text <words>]
node todos.mjs memory add --root <folder> --text "<rule>"
node todos.mjs explain  --space <id> --terminal t8r [--task '<task key>']   # or --root <folder> --memory <id>
```

Add `--state ~/.cache/herdr-todos/default` to read and change what the sidebar shows. Space ids come from `herdr-app status`.

**Other settings.** The environment wins over the settings file: `HERDR_TODOS_MODEL`, `HERDR_TODOS_COMPOSE_MODEL`, and `HERDR_TODOS_MODEL_CMD` (in the file: `"model_cmd": ["node", "my-model.mjs"]`), a command run instead of Pi for every model call. It gets `{"model","system","input"}` as JSON on stdin and prints the reply; use it for another provider or a recorded model in tests. `HERDR_TODOS_CONFIG` names another settings file.

## Troubleshooting

- **`./install.sh` says a mod failed its check.** The message names the file and the line. This page was checked on Herdr 0.1.14; update Herdr if yours is older.
- **Todos is not on the right after install.** Herdr docks it only the first time it sees the mod. Add `{ "type": "block", "content": { "mod": "todos" }, "size": { "px": 304 } }` to your layout's top row.
- **`place-memories.mjs` says "Todos is not in … yet".** Open Herdr once so Todos docks, then run it again, or pass your layout file.
- **"No Pi sessions in this space".** Todos lists Pi only, in the space in front of you. Start Pi in a pane here.
- **A card says "Waiting for this session's first message".** Pi has not written a conversation yet. Send a prompt.
- **A card says "Not updated: …".** The model call failed; the last good list stays. Run `pi -p --model anthropic/claude-haiku-4-5 "hi"` in a terminal: if that fails, log in to Pi or choose another model in the settings file.
- **Memories says "No project here yet."** The conversation's folder is not inside a git repository. Run `git init`.
- **No suggestion after a rule.** Suggestions come with the next Todos update; press **R** in Todos. Requests for features are dropped on purpose; a rule for future work ("always…", "never…", "we use…") is what it looks for.
- **`MEMORIES.md` words my rule differently.** The rewrite keeps the meaning in fewer words. Use **Edit** on the kept line, or edit the file.
- **What does the helper see?** `node ~/.config/herdr-app/mods/todos/todos.mjs describe` prints the commands, the models in use and the settings file.

## How it is built

| File | What it holds |
|---|---|
| `main.js` | The Todos widget, drawn with Herdr's UI kit: you describe cards, buttons and lists in JavaScript and Herdr draws them natively. It decides when to update and calls the helper. |
| `memories/main.js` | The Memories widget: suggestions, the editor, the kept list. |
| `menu/main.js` | The right-click menu both widgets open. |
| `nav.js`, `memories/nav.js` | The keyboard and scrolling rules, the same file in both widgets (a test checks the copies match). |
| `todos.mjs` | The helper, plain Node with no dependencies: finds the Pi terminals of a space, matches each to its conversation file, calls the model, writes `MEMORIES.md`. |
| `place-memories.mjs` | Puts Memories under Todos in a layout file. |
| `mod.json` (three) | Where each mod first appears: Todos on the right; Memories and the menu only where a layout or a widget puts them. |
| `test/`, `fence.sh` | The tests, and one command that runs every check. |

How one update runs:

1. **Gather, in code.** `hc ls` and `hc get` list the live Pi terminals of the space. Each is matched to its Pi conversation file: by a `pi.session` label, by the session name Pi reports, by the file the same process used last time, or the newest file in that folder.
2. **Skip what has not changed.** A conversation file of the same size and state as last time is not sent to a model.
3. **Judge, with the small model.** The recent conversation goes to the model with one job: a title, a "now" line and a short task list as JSON. A `todo` board is used as it is instead.
4. **Suggest memories.** Only your new prompts (and the reply each one reacts to) go to the small model with one question: did the person state a rule for future work here?
5. **Save.** Lists are saved per space under `~/.cache/herdr-todos/`, and the widgets draw from that.
6. **Keep.** A Keep rewrites `MEMORIES.md` with the larger model, checks in code that no kept memory was lost, and adds the link to `AGENTS.md` once.

## Build the same thing for another harness or workspace

The lesson's point is the idea, not this code: a small, light agent off to the side watches your conversations, and later you decide which of your decisions are worth keeping in the codebase. You need three things:

- **From the harness:** where it stores conversations, and a way to call a model once from a command line with no tools. In Pi these are the session files under `~/.pi/agent/sessions/` and `pi -p`.
- **From the workspace:** a way to list the panes of the place you are looking at, and somewhere to draw. In Herdr that is `hc` and a mod drawn with the UI kit.
- **A file your agents already read**, such as `AGENTS.md`, to link the memories from.

If your workspace has no UI kit, it probably has an extension or plugin system. Or show a web page from a dev server. Or build a terminal UI and leave it open in a pane; there are many good terminal UI libraries. There is no right or wrong way. `todos.mjs` does not draw anything, so it can feed any of them: `node todos.mjs refresh --space <id>` prints the lists as JSON.

A prompt to start from, in your harness repository:

> Build me a to-dos widget for my workspace. It watches every conversation in the space I am looking at. When a conversation changes, a small, fast model reads it and shows what it is doing, what is done and what is waiting on me. I never update it by hand. Under it, build a memories widget: when I type a prompt that states a rule for future work, suggest it off to the side. If I click Keep or press a shortcut, write that line to a memories file and link the file from AGENTS.md. Nothing is saved unless I keep it.

To make widgets the way the lesson does, ask for a `/widget` command ([herdr-pi-widget](https://github.com/johnlindquist/herdr-pi-widget)), grow each widget in the lab ([herdr-pi-lab](https://github.com/johnlindquist/herdr-pi-lab)) from a hello world up to what you need, then install it and pin it to the side. The Issues widget from the same lesson is [herdr-triage](https://github.com/johnlindquist/herdr-triage).

## Tested

What was checked for 0.1.0 on 2026-11-15 (macOS, Herdr 0.1.14, Pi 1.5.0, Node 25.2.1), and how:

- **Clean install.** A fresh clone of this repository, `./install.sh` into an empty Herdr home (`HERDR_APP_HOME`): `herdr-app check` passed for `todos`, `memories` and `todos-menu`.
- **The checks.** From the same clone, `npm install` and `npm run check`: syntax, types of the navigation rules and 12 tests passed.
- **The helper, end to end, on a fresh clone of RentAPlace.** A real Pi conversation on `anthropic/claude-haiku-4-5` asked for the cleaning-fee plan and was then told "keep all money in integer cents, never floats". A small script stood in for `hc` and reported that one terminal, so Herdr's own terminal list was not exercised. With the installed helper and real model calls: `refresh` returned the card and three tasks quoted in the walkthrough; `memories` listed "Keep all money in integer cents, never floats." as a suggestion; `memory accept` wrote the `MEMORIES.md` shown above and added the link line to `AGENTS.md`; `explain` printed the command for the forked Pi.
- **Not checked for this version:** the widgets drawn in a Herdr window installed from a clean clone, `place-memories.mjs` against a running window, spaces on other machines, and Node 22 to 24.

```sh
npm install
npm run check
```

## License

[MIT](LICENSE)
