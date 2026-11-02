import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as plugin from '../src/index.js';
import { createHost, textResponse } from './host.js';

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for lifecycle');
}
function field(value: unknown, name: string): number {
  assert(value && typeof value === 'object' && name in value);
  const found: unknown = Reflect.get(value, name); assert.equal(typeof found, 'number');
  if (typeof found !== 'number') throw new Error('Expected numeric field');
  return found;
}
const foreground = [process.execPath, '-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'];

test('real agent loop: two agents share one real process, cancel releases last reference, dispose reaps', async () => {
  const host = await createHost();
  try {
    await host.ctx.plugin(plugin, { enabled: true, mode: 'sleep', command: foreground });
    const status = async () => { const result = await host.execute('caffeinate', { action: 'status' }); assert(!result.isError); return result.value; };
    const initial = await status(); assert.equal(field(initial, 'pid'), 0);
    assert((await host.execute('caffeinate', { action: 'disable', revision: -1 })).isError);
    const a = await host.create('a'); const b = await host.create('b');
    // Keep real model requests pending until agent cancellation; no lifecycle events are forged.
    host.model.stream = async function* (request) {
      this.requests.push(request);
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      request.signal?.throwIfAborted();
      yield* textResponse();
    };
    const message = () => createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } });
    a.agent.followup(message()); b.agent.followup(message());
    await waitFor(async () => field(await status(), 'activeAgents') === 2 && field(await status(), 'pid') > 0);
    const started = await status(); const pid = field(started, 'pid'); process.kill(pid, 0);
    a.agent.cancel({ kind: 'user' }); await a.agent.whenIdle();
    const one = await status(); assert.equal(field(one, 'activeAgents'), 1); assert.equal(field(one, 'pid'), pid);
    b.agent.cancel({ kind: 'user' }); await b.agent.whenIdle();
    await waitFor(async () => field(await status(), 'pid') === 0); assert.throws(() => process.kill(pid, 0));
    a.agent.followup(message());
    await waitFor(async () => field(await status(), 'pid') > 0);
    const resumed = await status(); const pid2 = field(resumed, 'pid');
    const disabled = await host.execute('caffeinate', { action: 'disable', revision: field(resumed, 'revision') }); assert(!disabled.isError); assert.equal(field(disabled.value, 'pid'), 0); assert.throws(() => process.kill(pid2, 0));
    const enabled = await host.execute('caffeinate', { action: 'enable', revision: field(disabled.value, 'revision') }); assert(!enabled.isError); const pid3 = field(enabled.value, 'pid'); assert(pid3 > 0);
    await a.dispose();
    await waitFor(async () => field(await status(), 'pid') === 0); assert.throws(() => process.kill(pid3, 0));
    b.agent.followup(message());
    await waitFor(async () => field(await status(), 'pid') > 0);
    const pid4 = field(await status(), 'pid');
    await host.close(); assert.throws(() => process.kill(pid4, 0));
  } finally { await host.close(); }
});

test('real ToolRuntime validates arguments and cancellation; platform commands are explicit', async () => {
  const host = await createHost();
  try {
    await host.ctx.plugin(plugin, { enabled: true, mode: 'sleep', command: foreground });
    assert((await host.execute('caffeinate', { action: 'invalid' })).isError);
    const abort = new AbortController(); abort.abort();
    assert((await host.execute('caffeinate', { action: 'status' }, abort.signal)).isError);
    assert.throws(() => plugin.inhibitorCommand('win32', 'sleep'), /not implemented/);
    assert(plugin.inhibitorCommand('linux', 'display').includes('--what=idle:sleep'));
    assert(plugin.inhibitorCommand('darwin', 'display').includes('-d'));
  } finally { await host.close(); }
});

test('failed executable is reported without crashing or retaining a process', async () => {
  const host = await createHost();
  try {
    await host.ctx.plugin(plugin, { enabled: true, mode: 'sleep', command: ['/no/such/dsh-caffeinate-command'] });
    const agent = await host.create();
    host.model.responses.push(textResponse());
    agent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }));
    await agent.agent.whenIdle();
    const status = await host.execute('caffeinate', { action: 'status' }); assert(!status.isError);
    assert.match(JSON.stringify(status.value), /ENOENT|Inhibitor exited/);
    assert.equal(field(status.value, 'pid'), 0);
  } finally { await host.close(); }
});
