// Keeps one `wg agents` running in an Orca terminal, so that replies from the work-graph page reach agents.
// Orca accepts the reply mail only from a process in an Orca terminal; a launchd service cannot send it.
// Orca transpiles this file when it loads: no build step.
import type { OrcaWorkerApi } from 'orca/worker'

export const TITLE = 'wg agents'
// `--wait` waits while another sender holds the lock. The loop starts the sender again after it exits,
// for example when wg.py changed.
export const COMMAND = 'while :; do wg agents --wait; sleep 10; done'
const CHECK_MS = 60_000

type Workspace = { id: string; kind: string; path: string; hostId: string | null }
type Started = { workspaceId: string; terminalId: string }

const local = (w: Workspace) => w.hostId === 'local' || w.hostId === null
const trim = (path: string) => path.replace(/\/+$/, '')

/** The workspace for the terminal: the configured path, else the first local checkout named `work-graph`. */
export function pickWorkspace(workspaces: Workspace[], path: string): Workspace | undefined {
  if (path.trim()) return workspaces.find((w) => local(w) && trim(w.path) === trim(path.trim()))
  return workspaces.find((w) => local(w) && w.kind === 'worktree' && trim(w.path).split('/').pop() === 'work-graph')
}

/** Start the terminal when the one this plugin started is gone. Returns what it found or did. */
export async function ensure(orca: OrcaWorkerApi): Promise<'running' | 'started' | 'no workspace' | 'off'> {
  if ((await orca.settings.get('enabled')) === false) return 'off'
  const path = String((await orca.settings.get('workspacePath')) ?? '')
  const { workspaces } = await orca.host.call('workspace.list')
  const workspace = pickWorkspace(workspaces as Workspace[], path)
  if (!workspace) return 'no workspace'
  const started = (await orca.storage.get('terminal')) as Started | null
  if (started?.workspaceId === workspace.id) {
    const { terminals } = await orca.host.call('terminal.list', { workspaceId: workspace.id })
    if (terminals.some((t) => t.id === started.terminalId)) return 'running'
  }
  const { terminalId } = await orca.host.call('terminal.create', {
    workspaceId: workspace.id,
    title: TITLE,
    command: COMMAND
  })
  await orca.storage.set('terminal', { workspaceId: workspace.id, terminalId })
  orca.log(`started ${TITLE} in ${workspace.path} (${terminalId})`)
  return 'started'
}

let timer: ReturnType<typeof setInterval> | undefined

type Result = Awaited<ReturnType<typeof ensure>> | 'failed'
const LOOK: Record<Result, { icon: 'check' | 'warning' | 'pause' | 'error'; tone: 'success' | 'warning' | 'neutral' | 'danger'; tip: string }> = {
  running: { icon: 'check', tone: 'success', tip: 'wg agents runs in its Orca terminal' },
  started: { icon: 'check', tone: 'success', tip: 'wg agents started in a new Orca terminal' },
  'no workspace': { icon: 'warning', tone: 'warning', tip: 'No workspace: set "Workspace path" to a local work-graph checkout' },
  off: { icon: 'pause', tone: 'neutral', tip: 'Turned off in the plugin settings' },
  failed: { icon: 'error', tone: 'danger', tip: 'The check failed: see the plugin logs' }
}

/** Show the result in Orca's status bar. Click: check now. */
export async function show(orca: OrcaWorkerApi, result: Result, at = new Date()): Promise<void> {
  const look = LOOK[result]
  const time = at.toTimeString().slice(0, 5)
  try {
    await orca.host.call('statusBar.update', {
      id: 'sender',
      text: TITLE,
      icon: look.icon,
      tone: look.tone,
      tooltip: `${look.tip} (checked ${time}). Click to check now.`
    })
  } catch {
    // The status bar is in the desktop app only.
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  let running: Promise<unknown> | undefined
  let last = ''
  const check = () => {
    running ??= ensure(orca)
      .catch((error: unknown) => {
        orca.log(`check failed: ${error instanceof Error ? error.message : String(error)}`)
        return 'failed' as const
      })
      .then(async (result) => {
        await show(orca, result)
        if (result !== last && result !== 'running' && result !== 'failed') orca.log(result === 'no workspace'
          ? 'no workspace: set "Workspace path" to a local work-graph checkout'
          : result)
        last = result
        return result
      })
      .finally(() => { running = undefined })
    return running
  }
  orca.events.on('workspace.changed', async () => { await check() })
  orca.events.on('agent.status.changed', async () => { await check() })
  orca.commands.register('start', async () => {
    await check()
    return last === 'running' || last === 'started' ? `${TITLE}: ${last}` : `${TITLE}: ${last || 'see the plugin logs'}`
  })
  timer = setInterval(() => { void check() }, CHECK_MS)
  ;(timer as { unref?: () => void }).unref?.()
  void check()
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
