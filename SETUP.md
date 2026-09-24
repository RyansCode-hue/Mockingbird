# Setting up Mockingbird

Everything you need to go from nothing to a working app with your own agents and
your own Azure DevOps board. Nothing in the app is tied to the machine it was
built on: every default path is relative to *your* home folder, and your
identity comes from your own sign-ins and your own PAT.

## 1. Before you start

- **A Mac with Apple Silicon** (builds target `arm64`).
- **Claude Code**, installed and signed in (required):

  ```bash
  npm install -g @anthropic-ai/claude-code
  claude auth login
  ```

  Mockingbird launches and manages `claude` processes; it never needs an API
  key of its own.
- **Codex** (optional) — OpenAI's coding CLI, signed in with a ChatGPT
  subscription:

  ```bash
  npm install -g @openai/codex
  codex login
  ```

- **Azure CLI** (optional) — only the debrief assistant uses it, for
  `az boards` queries: `brew install azure-cli`.

Don't have npm? Install Node from [nodejs.org](https://nodejs.org) (or `brew
install node`) first.

## 2. Get the app

### Option A — you were sent a build

1. Unzip `Mockingbird-<version>-arm64-mac.zip` (or open the `.dmg`) and drag
   **Mockingbird.app** into **Applications**.
2. The build isn't signed with an Apple Developer ID, so the first launch needs
   one extra step: right-click the app → **Open** → **Open**. After that it
   opens normally. If macOS says the app "is damaged", clear the download flag
   once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Mockingbird.app
   ```

### Option B — build it yourself

Building needs **Node 22** (`node -v`); packaging fails on older versions.

```bash
git clone https://github.com/RyansCode-hue/Mockingbird.git
cd Mockingbird
npm install
npm start          # dev run
```

To install it as a real app:

```bash
npm run package
cp -R release/mac-arm64/Mockingbird.app /Applications/
```

Launch it from /Applications — not the copy inside `release/`, which the next
`npm run package` wipes.

> `npm install` uses node-pty's prebuilt binaries, so a broken C++ toolchain
> doesn't block you. If node-pty misbehaves after switching Node versions:
> `rm -rf node_modules package-lock.json && npm install`.

## 3. First run: the setup wizard

The first launch opens a setup wizard. Reopen it anytime from ⌘K → *Setup* or
Settings → General → **Run setup**. Each step checks this Mac's real state, so it's safe
to re-run and it picks up where you left off:

1. **Agents** — finds `claude` (required) and `codex` (optional) on your PATH
   and whether each is signed in, and shows the exact command to run if not
   (click a command to copy it). Fix anything in Terminal, then **Check again**.
2. **Status hooks** — one button adds Mockingbird's hooks for both agents, next
   to any hooks you already have. These are what turn each pane's dot teal
   (working), amber (needs you), or grey (idle).
3. **Repos** — the folders New Session scans for git repos. The defaults are
   `~/Code` and `~/Personal Projects`; remove any you don't have and add your
   own with **Add folder…**. Worktrees are created beside them in `worktrees/`.
4. **Azure DevOps** (optional) — see section 4. **Connect** only turns green
   after a live "Connected as …" check.
5. **Done** — the few shortcuts worth knowing, then straight into New Session.

Skipping the wizard is fine; everything in it is also in Settings.

## 4. Azure DevOps (Dashboard, ticket picker, debrief snapshots)

Each person needs **their own** personal access token (PAT). The Dashboard's
"Assigned to me", the ticket picker's default, and the debrief snapshots are all
keyed to whoever owns the token — someone else's PAT would show you their work.

1. In Azure DevOps: your avatar → **User settings** → **Personal access
   tokens** → **New Token**. Scope: **Work Items → Read & Write**. Copy it.
2. Save it to a file **outside any git repo**, in your WorkTracker folder (any
   folder works — it just holds `config.json` and debrief notes):

   ```bash
   mkdir -p ~/Code/WorkTracker/secrets
   pbpaste > ~/Code/WorkTracker/secrets/ado_pat.txt
   ```

3. In the wizard's Azure DevOps step (or Settings → **Azure DevOps**), fill in:
   - WorkTracker folder — e.g. `~/Code/WorkTracker`
   - Organization URL — `https://dev.azure.com/YourOrg`
   - Project — your project name
   - Token file — the file from step 2

   and press **Connect** (**Save and connect** in Settings). It should show
   *Connected as \<you\>*.

The PAT never leaves Mockingbird's main process, and the `secrets/` /
`*_pat.txt` naming is chosen so it's easy to keep out of commits. When the token
expires, save the new one over the same file.

## 5. Codex (optional)

With Codex installed and signed in (section 1), pick **Codex** in New Session.
Two one-time prompts come from Codex itself, inside the pane:

- **"Do you trust this directory?"** — once per worktree. Answer yes.
- **"Hooks need review"** — once, after the wizard installs Codex's hooks. Choose
  **Trust all and continue** (or type `/hooks` and press `t`). Until then Codex
  panes won't show working / waiting / idle.

Plan usage in the status bar is Claude-only; Codex doesn't expose its limits.

## 6. Agents messaging each other

Nothing to set up. Every Claude and Codex pane gets `list_sessions` and
`send_message` tools, so you can say "tell the backoffice session the field is
now `organizationId`" and it lands in that pane's prompt. Sessions started
before an app update need a restart to get the tools. Settings → Agents →
**Auto-send agent messages** switches it off if you'd rather press Enter on each one.

## 7. Debriefs (optional)

The morning brief / 4pm wrap-up launch an assistant session in your WorkTracker
folder following `instructions/morning.md` / `wrap-up.md` there — write those
however you like. Without them (or without the Azure CLI), the assistant does
what it can and says what it couldn't reach.

## 8. Keeping things up to date

- **Claude Code / Codex** — Settings → Agents → **Update** next to each,
  then **Restart all sessions**. You need this when a new model (e.g. a new
  Opus) says the CLI must update. Restarting relaunches every pane in place and
  resumes its conversation; groups and grid slots survive.
- **Mockingbird** — a teal "⭮ vX.Y available" link appears in the status bar
  when a newer release is published. Install it the same way as section 2.

## 9. Good to know

- **Open Mockingbird from the Dock, Finder, or Spotlight.** Launching it from a
  terminal that's running inside a Claude Code session hands it that session's
  environment. The app strips those variables before starting panes, but a
  clean launch is the safe habit.
- **One instance at a time.** State lives in `~/.mockingbird/state.json`;
  running a dev build and the packaged app together makes them fight over it.
- **Diagnostics**: `~/.mockingbird/main.log` has main-process errors, and
  `~/.mockingbird/pty-audit.log` records any input the app refused to forward to
  a session (the tripwire for stray bytes typing commands into a pane).
- **Dev loop**: renderer changes are `npm run build` + ⌘R; main-process changes
  need an app restart.
