// Runs the worker as Orca would, against a stand-in host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const capabilities = ['workspace:read', 'agent:read', 'terminal:send', 'storage:own', 'settings:own']
const checkout = { id: 'w1', kind: 'worktree', name: 'main', path: '/src/work-graph', branch: 'main', hostId: 'local' }
const other = { id: 'w2', kind: 'worktree', name: 'x', path: '/src/other', branch: 'main', hostId: 'local' }
const remote = { ...checkout, id: 'w3', hostId: 'ssh:box' }

test('picks the configured path, else the first local work-graph checkout', () => {
  assert.equal(main.pickWorkspace([remote, other, checkout], '')?.id, 'w1')
  assert.equal(main.pickWorkspace([checkout, other], '/src/other/')?.id, 'w2')
  assert.equal(main.pickWorkspace([remote, other], ''), undefined)
})

const host = (settings: Record<string, string | boolean>) => mockHost({
  capabilities,
  settings,
  results: {
    'workspace.list': { workspaces: [other, checkout], truncated: false },
    'terminal.create': { terminalId: 't1' },
    'terminal.list': { terminals: [{ id: 't1', title: main.TITLE }], truncated: false }
  }
})
const mount = (h: ReturnType<typeof mockHost>) =>
  mountWorker(main, { host: h, events: ['workspace.changed', 'agent.status.changed'], commands: ['start'] })

test('starts the terminal once, and again after it closes', async () => {
  const h = host({ enabled: true, workspacePath: '' })
  const worker = await mount(h)
  assert.equal(await worker.command('start'), 'wg agents: started')
  assert.deepEqual(h.callsOf('terminal.create'), [
    { workspaceId: 'w1', title: main.TITLE, command: main.COMMAND }
  ])
  assert.equal(await worker.command('start'), 'wg agents: running')
  h.respond('terminal.list', { terminals: [], truncated: false })
  h.respond('terminal.create', { terminalId: 't2' })
  await worker.emit('workspace.changed', { context: null })
  h.respond('terminal.list', { terminals: [{ id: 't2', title: main.TITLE }], truncated: false })
  assert.equal(await worker.command('start'), 'wg agents: running')
  assert.equal(h.callsOf('terminal.create').length, 2)
  const bar = h.callsOf('statusBar.update') as { tone: string; icon: string }[]
  assert.deepEqual([bar.at(-1)?.tone, bar.at(-1)?.icon], ['success', 'check'])
  await worker.deactivate()
})

test('does nothing when turned off', async () => {
  const h = host({ enabled: false, workspacePath: '' })
  const worker = await mount(h)
  assert.equal(await worker.command('start'), 'wg agents: off')
  assert.equal(h.callsOf('terminal.create').length, 0)
  await worker.deactivate()
})

test('shows a failed check in red', async () => {
  const h = host({ enabled: true, workspacePath: '' })
  h.respond('workspace.list', { workspaces: [], truncated: false })
  const worker = await mount(h)
  assert.equal(await worker.command('start'), 'wg agents: no workspace')
  const bar = h.callsOf('statusBar.update') as { tone: string }[]
  assert.equal(bar.at(-1)?.tone, 'warning')
  await worker.deactivate()
})
