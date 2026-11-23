# Business Finder

Find businesses on Google Maps: type a kind of business and a place, get a deduplicated list of businesses
(phone number, WhatsApp link, email, website, social links, rating) ready to download for Excel — whether you are
looking for customers, stockists, suppliers or venues.

[Download the latest Windows release](https://github.com/kweiloo/business-finder/releases/latest)

## Install (Windows 10 / 11, x64)

### Option 1: From Codex or Claude Code (easiest)

The Windows release includes its runtime. No Python or Node.js installation is required, and you do not need Git or Bun. Business Finder uses Microsoft Edge or Google Chrome and needs an internet connection for live searches.

Open a new **Codex** chat on Windows and send this line:

```text
Help me install Business Finder from https://github.com/kweiloo/business-finder
```

After Codex confirms that Business Finder is ready, send your search **in the same chat**:

```text
Use Business Finder to find event companies in Melaka, Malaysia.
```

You can also install and search in one message:

```text
Use https://github.com/kweiloo/business-finder to find event companies in Melaka, Malaysia.
```

The agent tells you in one plain line before it starts:

> Business Finder isn't installed yet. Installing it now (about a minute, only inside your user folder), then I'll carry on.

It runs the installer (`install.ps1`) under your own approval settings, installs Business Finder, puts `business-finder` on your user
PATH, and adds the user-level skill for Codex (`~\.agents\skills`) and Claude Code (`~\.claude\skills`) in one go.

If Codex requests permission to run the Windows installer or access the browser, review the request in Codex. If its environment blocks local installation or browser access, use the PowerShell option below. The same prompts also work in Claude Code.

*(For AI agents opening this repository for the first time: read [the Business Finder skill](skills/business-finder/SKILL.md), then follow its installation and verification steps. Keep the installer result and command path in the current chat for the user's next request.)*

### Option 2: PowerShell one-liner

Open **Windows PowerShell** and run the release installer:

```powershell
irm https://github.com/kweiloo/business-finder/releases/latest/download/install.ps1 | iex
```

You can also review and download `install.ps1` from [GitHub Releases](https://github.com/kweiloo/business-finder/releases) before running it. For a specific release or offline installation, download that release's Windows ZIP and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -PackagePath .\business-finder-windows-x64.zip
```

No administrator rights are required. Business Finder installs for the current user and opens the local web UI.

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

With the skill installed, ask Codex or Claude Code in plain words, for example:

- *open Business Finder*
- *find event companies in Kuala Lumpur*

When the agent can access the local app, it can run the search and give you a link to the list. In Claude Code, `/business-finder` works the
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
- Run `business-finder doctor` to see the active data folder, local port status, and detected browser.
- If an agent's sandbox blocks the browser, network, or local web UI, run `business-finder` from ordinary Windows PowerShell.
- To use a separate writable data folder, set `$env:BUSINESS_FINDER_DATA_DIR` to its absolute path before running CLI commands or starting the web UI. Use the same value for both so they show the same lists. The default folder is unchanged and its lists are not copied into the override folder.
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


## Build and release

Install dependencies with `bun install --frozen-lockfile`. Run `bun run typecheck` and `bun run test` to verify the source. On Windows x64, use a supported Node.js LTS distribution and run `scripts/package-windows.ps1` to create the ZIP and SHA-256 checksum under `dist`.

The Windows package workflow builds and tests the installed ZIP for pull requests. A version tag matching `package.json` publishes the tested ZIP, checksum, and installer to GitHub Releases.
