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

export default function activate(orca: OrcaWorkerApi): void {
  let running: Promise<unknown> | undefined
  let last = ''
  const check = () => {
    running ??= ensure(orca)
      .then((result) => {
        if (result !== last && result !== 'running') orca.log(result === 'no workspace'
          ? 'no workspace: set "Workspace path" to a local work-graph checkout'
          : result)
        last = result
        return result
      })
      .catch((error: unknown) => orca.log(`check failed: ${error instanceof Error ? error.message : String(error)}`))
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
