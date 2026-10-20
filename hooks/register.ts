import type { EngineInterface, Register, SessionMessage, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

// ---- Agent types and Codex settings ----

type CodexAgentSettings = { model: string; profile: string; instructions: string; extraArgs: readonly string[] }

// When to delegate to each type, `<plugin>:<name>`; its model, profile, and optional instructions come from the
// `<name>Model`, `<name>Profile`, and `<name>Instructions` options.
const CODEX_AGENT_USES: Record<string, string> = {
  sol: 'most scoped coding, investigation, and verification tasks',
  astra: 'consequential planning, deep debugging, or architectural uncertainty',
  reviewer: 'independent review of requirements, implementation history, and regressions; it does not edit reviewed files',
}
// The initial effort of every type; each step's effort, adapted or not, becomes Codex's model_reasoning_effort.
const INITIAL_EFFORT = 'high'
// Registered agent types need a system prompt; no request ever carries it, since the turn.step hook answers every step.
const PLACEHOLDER_PROMPT = 'Codex answers every turn of this agent type through the codex plugin; this prompt is never sent to a model.'

const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// One store key per agent: `$.store` has no atomic update, so a shared map would lose parallel agents' writes.
const THREAD_KEY_PREFIX = 'thread:'
const MAX_STORED_THREADS = 1024
const KEPT_STORED_THREADS = 512
const PROGRESS_BLOCK_INDEX = 0
const ANSWER_BLOCK_INDEX = 1

type StoredThread = { threadId: string; updatedAt: number }

// ---- Agent and thread lookup ----

const agentTypeById = new Map<string, string>()
// User rows appended to each subagent's conversation since its last step. A message delivered while a Codex turn
// runs is appended as that turn ends and is not yet in `$.session.messages` when the next step reads it.
const pendingTextsByAgentId = new Map<string, string[]>()

function findCodexAgentSettings(
  settingsByName: ReadonlyMap<string, CodexAgentSettings>,
  pluginName: string,
  agentId: string,
): CodexAgentSettings | undefined {
  const [plugin, name] = (agentTypeById.get(agentId) ?? '').split(':')
  return plugin === pluginName && name !== undefined ? settingsByName.get(name) : undefined
}

async function loadAgentType($: EngineInterface, agentId: string): Promise<void> {
  if (agentTypeById.has(agentId)) return
  for (const agent of await $.agent.list()) agentTypeById.set(agent.id, agent.type)
}

async function readThreadId($: EngineInterface, agentId: string): Promise<string | undefined> {
  return ((await $.store.get(THREAD_KEY_PREFIX + agentId)) as StoredThread | undefined)?.threadId
}

async function saveThreadId($: EngineInterface, agentId: string, threadId: string): Promise<void> {
  await $.store.set(THREAD_KEY_PREFIX + agentId, { threadId, updatedAt: await $.clock.now() })
  const threadKeys = (await $.store.keys()).filter(key => key.startsWith(THREAD_KEY_PREFIX))
  if (threadKeys.length <= MAX_STORED_THREADS) return
  const stored = await Promise.all(threadKeys.map(async key => ({ key, thread: (await $.store.get(key)) as StoredThread })))
  const oldest = stored.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt).slice(KEPT_STORED_THREADS)
  await Promise.all(oldest.map(({ key }) => $.store.delete(key)))
}

// ---- Prompt and command ----

// A resumed thread already holds the history, so it gets only the new messages: the appended user rows, or the user
// rows after the last answer when none were seen (a reload lost them). Rows, not the API form: the API form also
// renders the session's attachments (environment, instructions) as text. Without a stored thread (store lost, resume
// failed), earlier rows are replayed as text so a new thread keeps the context.
function composeCodexPrompt(messages: readonly SessionMessage[], appendedTexts: readonly string[], hasThread: boolean): string {
  const lastAnswerIndex = messages.map(message => message.role).lastIndexOf('assistant')
  const newTexts = appendedTexts.length > 0 ? appendedTexts : messages.slice(lastAnswerIndex + 1).map(message => message.text)
  const pending = newTexts.map(text => text.trim()).filter(Boolean).join('\n\n')
  if (!pending || hasThread || lastAnswerIndex < 0) return pending
  const history = messages.slice(0, lastAnswerIndex + 1).map(message => `[${message.role}]\n${message.text.trim()}`).join('\n\n')
  return `Earlier conversation of this task (its Codex thread is unavailable):\n\n${history}\n\nNew message:\n\n${pending}`
}

function buildCodexArgv(settings: CodexAgentSettings, cwd: string, effort: TurnStepInput['effort'], threadId?: string): string[] {
  return [
    'codex', 'exec', '--json', '--skip-git-repo-check', '-C', cwd,
    ...(settings.profile ? ['-p', settings.profile] : []),
    ...(settings.model ? ['-m', settings.model] : []),
    '-c', `developer_instructions=${JSON.stringify(settings.instructions)}`,
    ...settings.extraArgs,
    ...(typeof effort === 'string' && CODEX_EFFORTS.has(effort) ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ...(threadId === undefined ? [] : ['resume', threadId]),
    '-',
  ]
}

// ---- Codex event rendering ----

type CodexItem = {
  type: string
  text?: string
  command?: string
  changes?: { path: string; kind: string }[]
  query?: string
  server?: string
  tool?: string
  message?: string
}
type CodexEvent = { type: string; thread_id?: string; item?: CodexItem; error?: { message?: string }; message?: string }

function describeCodexItem(item: CodexItem): string | undefined {
  switch (item.type) {
    case 'command_execution':
      return `$ ${(item.command ?? '').slice(0, 300)}`
    case 'file_change':
      return `edit ${(item.changes ?? []).map(change => `${change.kind} ${change.path}`).join(', ')}`
    case 'web_search':
      return `web search: ${item.query ?? ''}`
    case 'mcp_tool_call':
      return `mcp ${item.server ?? ''}/${item.tool ?? ''}`
    case 'reasoning':
      return item.text
    case 'error':
      return `error: ${item.message ?? ''}`
    default:
      return undefined
  }
}

function toProgressChunk(text: string): TurnStepChunk {
  return { kind: 'thinking', index: PROGRESS_BLOCK_INDEX, text: `${text}\n` }
}

async function* answerStep(e: TurnStepInput, answer: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: ANSWER_BLOCK_INDEX, text: answer }
  // No usage: the counts are OpenAI tokens, which Claude Code would price and compact as Claude's.
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
}

// ---- Options ----

function readStringOption(options: Record<string, unknown>, name: string): string {
  const value = options[name] ?? ''
  if (typeof value !== 'string') throw new Error(`codex: option ${name} must be a string`)
  return value.trim()
}

// An invalid option fails the module load, so no agent type is registered and spawning one fails.
function readAgentSettings(options: Record<string, unknown>): Map<string, CodexAgentSettings> {
  const instructions = readStringOption(options, 'instructions')
  if (!instructions) throw new Error('codex: option instructions must not be blank')
  const extraArgs: unknown = JSON.parse(readStringOption(options, 'codexArgs') || '[]')
  if (!Array.isArray(extraArgs) || !extraArgs.every(arg => typeof arg === 'string')) {
    throw new Error('codex: option codexArgs must be a JSON array of strings')
  }
  return new Map(
    Object.keys(CODEX_AGENT_USES).map(name => {
      const model = readStringOption(options, `${name}Model`)
      if (!model) throw new Error(`codex: option ${name}Model must not be blank`)
      const typeInstructions = readStringOption(options, `${name}Instructions`) || instructions
      return [name, { model, profile: readStringOption(options, `${name}Profile`), instructions: typeInstructions, extraArgs }]
    }),
  )
}

// ---- Hooks ----

export const register: Register = (on, options) => {
  const settingsByName = readAgentSettings(options)

  // Registered here, not as agent files: a module that fails to load leaves no type that a Claude model could answer.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const [name, settings] of settingsByName) {
      await $.agent.register({
        name,
        description: `OpenAI ${settings.model} through Codex, which runs its own tools and sandbox. Use for ${CODEX_AGENT_USES[name]}; SendMessage continues its thread.`,
        prompt: PLACEHOLDER_PROMPT,
        model: settings.model,
        effort: INITIAL_EFFORT,
        tools: [],
        omitClaudeMd: true,
      })
    }
    return started
  })

  on('session.append', ($, e, next) => {
    if (e.agentId !== undefined && e.message.type === 'user' && e.message.role === 'user') {
      const text = e.message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n\n')
      pendingTextsByAgentId.set(e.agentId, [...(pendingTextsByAgentId.get(e.agentId) ?? []), text])
    }
    return next(e)
  })

  // A spawn fails when Codex cannot run, rather than starting an agent whose first turn would fail.
  on('agent.spawn', async ($, e, next) => {
    const [plugin, name] = e.subagentType.split(':')
    if (plugin !== $.plugin.name || name === undefined || !settingsByName.has(name)) return next(e)
    const probe = await $.process.run(['codex', '--version']).catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
    if (probe.exitCode !== 0) return { deny: `${e.subagentType}: codex cannot run: ${probe.stderr.trim()}` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${e.subagentType}: codex spawn check failed: ${next.error.message ?? next.error.kind}` }))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const appendedTexts = pendingTextsByAgentId.get(e.agentId) ?? []
    pendingTextsByAgentId.delete(e.agentId)
    await loadAgentType($, e.agentId)
    const settings = findCodexAgentSettings(settingsByName, $.plugin.name, e.agentId)
    if (settings === undefined) return yield* next(e)
    const agentId = e.agentId

    const messages = await $.session.messages({ agentId })
    if (!Array.isArray(messages)) throw new Error(`cannot read subagent ${agentId}: ${messages.deny}`)
    let threadId = await readThreadId($, agentId)
    const prompt = composeCodexPrompt(messages, appendedTexts, threadId !== undefined)
    if (!prompt) return yield* answerStep(e, 'No new message reached the Codex subagent; no Codex turn ran.')
    const cwd = await $.session.cwd()

    // Interim agent messages are progress; only the turn's last one is the answer the parent reads.
    let answer = ''
    let failure: string | undefined
    let hasStartedThread = false
    let stderrTail = ''
    let unparsed = ''
    async function* readCodexLine(line: string): AsyncGenerator<TurnStepChunk> {
      let event: CodexEvent
      try {
        event = JSON.parse(line) as CodexEvent
      } catch {
        yield toProgressChunk(line)
        return
      }
      if (event.type === 'thread.started' && event.thread_id !== undefined) {
        hasStartedThread = true
        threadId = event.thread_id
        await saveThreadId($, agentId, threadId)
      } else if ((event.type === 'item.started' || event.type === 'item.completed') && event.item !== undefined) {
        const item = event.item
        if (item.type === 'agent_message' && event.type === 'item.completed') {
          if (answer) yield toProgressChunk(answer)
          answer = item.text ?? ''
        } else if (event.type === 'item.started' || item.type === 'reasoning' || item.type === 'error') {
          const description = describeCodexItem(item)
          if (description) yield toProgressChunk(description)
        }
      } else if (event.type === 'turn.failed') {
        failure = event.error?.message ?? 'turn failed'
      } else if (event.type === 'error') {
        // Codex also reports retried stream errors this way; only turn.failed or the exit code mean failure.
        yield toProgressChunk(`error: ${event.message ?? ''}`)
      }
    }

    const child = $.process.spawn({ argv: buildCodexArgv(settings, cwd, e.effort, threadId), cwd, input: prompt })
    yield toProgressChunk(`codex ${settings.model || 'default model'}${threadId === undefined ? '' : ` (resume ${threadId})`}`)
    for await (const piece of child) {
      if (piece.stream === 'stderr') {
        stderrTail = (stderrTail + piece.text).slice(-4000)
        continue
      }
      const lines = (unparsed + piece.text).split('\n')
      unparsed = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) yield* readCodexLine(line)
    }
    if (unparsed) yield* readCodexLine(unparsed)
    const exit = await child.result

    if (next.signal.aborted) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    if (failure !== undefined || exit.code !== 0) {
      const reason = failure ?? `codex exited with ${exit.code ?? exit.signal}: ${stderrTail.trim()}`
      // A thread that cannot be resumed would fail every later message; forget it so the next one replays the conversation.
      const forgetNote = threadId !== undefined && !hasStartedThread ? ' Its Codex thread was forgotten; the next message starts a new one.' : ''
      if (forgetNote) await $.store.delete(THREAD_KEY_PREFIX + agentId)
      answer = `${answer}\n\nCodex subagent failed: ${reason}${forgetNote}`.trim()
    }
    return yield* answerStep(e, answer || 'Codex returned no final message.')
  }).catch(async function* ($, e, next) {
    // Without this answer the engine would send the step to the agent file's Claude model.
    if (next.called || e.agentId === undefined || !findCodexAgentSettings(settingsByName, $.plugin.name, e.agentId)) return yield* next(e)
    return yield* answerStep(e, `Codex subagent failed: ${next.error.message ?? next.error.kind}`)
  })
}
