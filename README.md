# Codex subagents for Claude Code

OpenAI models, run by the Codex CLI, as native Claude Code subagent types. Claude Code hosts each subagent (Agent tool, background runs, SendMessage, transcript); Codex runs every turn with its own tools, sandbox, login, and config. No Claude model request is made for these agents.

- Requires a logged-in [Codex CLI](https://github.com/openai/codex) on `PATH` and a Claude Code build with function-hook mods (tested on 2.1.299).

  **Marketplace installation**

  ```bash
  claude plugin marketplace add trungnt13/claude-codex-subagents
  claude plugin install codex@tngo-codex --scope user
  ```

  **Local loading**, from the repository directory; no installation required:

  ```bash
  claude --plugin-dir .
  ```

- Agent types, chosen by `subagent_type`:
  - `codex:sol`: `gpt-6.1-sol` by default; most scoped coding, investigation, and verification tasks.
  - `codex:astra`: `gpt-6-astra` by default; consequential planning, deep debugging, or architectural uncertainty.
  - Change models or add a Codex profile with the `solModel`, `solProfile`, `astraModel`, and `astraProfile` options.
- Each turn runs `codex exec --json` in the subagent's working directory.
  - The first turn starts a Codex thread; later turns (SendMessage) run `codex exec resume <thread>` with only the new message.
  - Thread ids persist per agent in the plugin store, so resuming survives reloads and restarts.
  - Without a usable thread (store lost, resume failed), the next turn starts a new thread with the conversation replayed as text.
  - Each step's Claude effort (`low` to `max`) becomes `model_reasoning_effort`; other values keep the Codex config's.
  - Codex tool activity streams as progress (shown, not recorded); the last Codex message is the subagent's answer.
  - Failures answer as `Codex subagent failed: <reason>`; they never fall back to a Claude model.
- Options (`/plugin` config menu, or `claude plugin configure codex --values-stdin` with a JSON object of single-line strings):
  - `instructions`: Codex developer instructions for every turn; a generic subagent brief by default.
  - `codexArgs`: JSON array of extra `codex exec` arguments, `["--disable", "multi_agent"]` by default; add `["-c", "key=value"]` config overrides here.
  - An invalid option stops the mod from loading; its agent types then answer with a not-loaded notice.
- Limitations:
  - Claude Code's permission mode and tool hooks do not reach Codex; Codex's own sandbox and approval settings apply, and `codex exec` cannot ask for approval.
  - Claude Code shows these agents with their placeholder Claude model (`sonnet`), zero tool uses, and no token usage; reporting OpenAI tokens would make Claude Code price and compact them as Claude tokens.
  - Each turn starts a new `codex exec` process.
