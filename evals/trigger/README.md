## Skill trigger eval

Checks whether `codex exec` picks the `business-finder` skill for plain
requests that never name it, and leaves it alone for requests that are not
about finding businesses. It is a regression net for `codex exec`, not proof
of what the Codex desktop app does.

**What it does not model:** the Codex desktop app's preference for web
search. On `main` @ `0632bee`, the desktop app answered `帮我找马六甲的 event 公司`
with its own web search and never used the skill. Under `codex exec`, the
same description triggers on all 12 should-trigger prompts, with or without
the user's other skills installed. A good score here does not show that the
desktop app will pick the skill. That needs a manual test in the desktop app.

- `prompts.json`:
  - 12 should-trigger prompts: 8 `dev`, and 4 `heldout` that were never used
    while writing the description.
  - 6 `negative` prompts.
  - 2 `link` prompts: the repository link plus a task, with Business Finder
    not installed.
- `run.ts` runs each prompt as one `codex exec` session, with:
  - a throwaway `CODEX_HOME` holding a copy of your Codex login, the skill
    under test and Codex's bundled skills;
  - a throwaway home folder;
  - `stub.ps1` on `PATH` as `business-finder`. The stub logs its arguments
    and prints a canned result, so no Google Maps search runs.
- A session counts as triggered when the stub was called, or when a shell
  command read the skill or called `business-finder` (including a command
  Codex refused).
- A `link` session starts with no skill and no `business-finder` on `PATH`.
  - Git URLs for the GitHub repository point to a local mirror of this
    checkout. In that mirror, `src/cli/main.ts` is replaced by
    `cli-stub.ts`, which logs calls and searches nothing.
  - `install.ps1` runs for real against the mirror. It writes its user
    `PATH` to a throwaway registry key instead of `Environment`.
  - The session passes when `install.ps1` ran and was then followed by a
    `lists` or `scrape` call, in the same session.

```powershell
bun evals/trigger/run.ts --label new                                    # skill alone
bun evals/trigger/run.ts --label new --with-user-skills                 # next to your own ~\.agents\skills
bun evals/trigger/run.ts --label old --skill path\to\old\SKILL.md --only T01,N04
bun evals/trigger/run.ts --label link --with-user-skills --only L01,L02 # install then search, one session
```

- `--with-user-skills` keeps your own skills switched on (read only). Only
  your installed `business-finder` is swapped for the one under test. This is
  closer to a real Codex setup.
- Each run uses one Codex session per prompt: 20 for the full set.
- Results go to `evals/trigger/results/` (not committed).
- Each run prints the user and machine `PATH` hashes before and after, and
  whether the real `auth.json` and `~\.agents` changed.

Sessions run without Codex's sandbox: on Windows, `codex exec` refuses every
shell command inside it, which would block the skill read itself. Because
they also have live web search:
- each session gets only the Windows and Codex environment variables it needs
  (none of your tokens or keys);
- installed `business-finder` folders are taken off its `PATH`;
- the copy of your login is deleted as soon as its session ends.

Run it only with the prompts in `prompts.json` or prompts you wrote yourself.
