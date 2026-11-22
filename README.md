# Business Finder

Find businesses on Google Maps: type a kind of business and a place, get a deduplicated list of businesses
(phone number, WhatsApp link, email, website, social links, rating) ready to download for Excel — whether you are
looking for customers, stockists, suppliers or venues.

## Install (Windows 10 / 11)

### Option 1: From Codex or Claude Code (easiest)

Needs **no Python or Node.js**.

In **Codex** (or **Claude Code**), say what you want to find and where to get Business Finder, in one sentence:

```text
Use github.com/kweiloo/business-finder to find event companies in Melaka
```

The agent tells you in one plain line before it starts:

> Business Finder isn't installed yet. Installing it now (about a minute, only inside your user folder), then I'll carry on.

It runs the installer (`install.ps1`) under your own approval settings, installs Business Finder, puts `business-finder` on your user
PATH, and adds the user-level skill for Codex (`~\.agents\skills`) and Claude Code (`~\.claude\skills`) in one go.
*(While the repository is private, Git needs to be logged into GitHub.)*

Then it carries on with your request in the same chat: no restart and no new chat. Later, in any chat, ask in plain
words, for example *open Business Finder* or *find event companies in Kuala Lumpur*.

*(For AI agents reading this repository: when asked to install Business Finder or its skill, follow `skills/business-finder/SKILL.md` under `## Installing` — say the single line above and run `install.ps1` right away so both the app and the user-level skills under `~\.agents\skills` and `~\.claude\skills` are installed. Never copy `SKILL.md` by hand, never run more than the installer, never use `$skill-installer`, never install into the current workspace, and never run from a clone.)*

### Option 2: PowerShell one-liner

Open **PowerShell** (press Start, type `PowerShell`, press Enter), paste this line and press Enter (once the repository is public):

```powershell
irm https://raw.githubusercontent.com/kweiloo/business-finder/main/install.ps1 | iex
```

While the repository is private, if you have **Git** installed and logged into GitHub, run each command in PowerShell:

```powershell
git clone https://github.com/kweiloo/business-finder.git "$env:TEMP\business-finder-install"
```

```powershell
powershell -ExecutionPolicy Bypass -File "$env:TEMP\business-finder-install\install.ps1"; Remove-Item -Recurse -Force "$env:TEMP\business-finder-install"
```

**No Git?** On GitHub, click **Code → Download ZIP**, extract the folder, open PowerShell inside that
extracted folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It takes about a minute. No administrator rights are needed, and nothing is installed outside your own user
folder. When it is done, Business Finder opens in your browser and the last line tells you the address.

### For developers

These install **only** the skill or plugin (not the Windows app itself), and require Node.js or Python:

- **Skills CLI (needs Node.js):**
  ```powershell
  npx skills add kweiloo/business-finder
  ```
- **Codex skill installer (needs Python):** `$skill-installer` from `github.com/kweiloo/business-finder`
- **Claude Code plugin marketplace (2.1.275 or later):**
  ```text
  /plugin install business-finder --marketplace kweiloo/business-finder
  ```
  Or in two steps:
  ```text
  /plugin marketplace add kweiloo/business-finder
  ```
  ```text
  /plugin install business-finder@business-finder
  ```

## Use

1. Under **What**, type the kind of business (for example `event companies`); under **Where**, a city or area (for a whole state, list a few of its towns), for example `Kuala Lumpur` or `Lisbon, Portugal`.
2. Click **Find** and wait. Business Finder searches Google Maps, then checks each business's website for phone numbers, WhatsApp links and emails.
3. Click **Download for Excel**.

To open Business Finder again later, type `business-finder` in PowerShell, or ask Codex to *open Business Finder*.
Your lists stay in the page, on the left.

## Using it from Codex or Claude Code

After the install, Codex and Claude Code know Business Finder in any folder. Ask in
plain words, for example:

- *open Business Finder*
- *find event companies in Kuala Lumpur*

Codex runs the search and gives you a link to the list in the page. In Claude Code, `/business-finder` works the
same way (`/business-finder event companies in Kuala Lumpur`).

## Update

Run the same install command again. It updates Business Finder and keeps your saved lists (they live in
`%LOCALAPPDATA%\business-finder\jobs`).

## Uninstall

Run:

```powershell
business-finder uninstall
```

This stops Business Finder and removes the app, the `business-finder` command, and the Codex and Claude Code skills. It
asks before deleting your saved lists; press Enter to keep them.

## Troubleshooting

- `business-finder` is not recognised: close PowerShell and open a new window, then try again.
- Run `business-finder doctor` to check that Business Finder finds Microsoft Edge or Google Chrome, which it needs to search.
- If the install stops, it says why in plain words. Check your internet connection and run the same command again.
- If a run stops without finishing, ask Codex to run it again with the debug log on. If you run commands
  yourself, set `BUSINESS_FINDER_DEBUG_LOG` to a file path first:

```powershell
$env:BUSINESS_FINDER_DEBUG_LOG = "$env:TEMP\business-finder-debug.log"
```

```powershell
business-finder scrape "event companies" --city "Kuala Lumpur"
```

Business Finder appends one line per stage and per website check to that file, with timings and website hosts, so
the last lines show where it stopped. Nothing is logged when the variable is unset.

## Licence

MIT
