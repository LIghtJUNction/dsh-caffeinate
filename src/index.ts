import { spawn, type ChildProcess } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-caffeinate';
export const inject = ['tools', 'agents'];
export interface Config { enabled: boolean; mode: 'sleep' | 'display'; command?: string[] }
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  mode: Schema.union(['sleep', 'display']).default('sleep'),
  command: Schema.array(Schema.string()).description('Trusted host argv override, no shell expansion. Must stay foreground and release on stdin EOF. Intended for unusual hosts and diagnostics.'),
});

export function inhibitorCommand(platform: string, mode: Config['mode']): string[] {
  if (platform === 'darwin') return ['caffeinate', ...(mode === 'display' ? ['-i', '-d'] : ['-i']), '-w', String(process.pid)];
  if (platform === 'linux') return ['systemd-inhibit', `--what=${mode === 'display' ? 'idle:sleep' : 'sleep'}`, '--who=dsh-caffeinate', '--why=DSH agent is running', '--mode=block', process.execPath, '-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'];
  throw new Error('Only Linux and macOS are supported; Windows is not implemented');
}

export function apply(ctx: Context, config: Config) {
  const active = new Set<Agent>();
  let child: ChildProcess | undefined;
  let exitWait: Promise<void> = Promise.resolve();
  let disposed = false;
  let enabled = config.enabled;
  let error = '';
  let revision = 0;
  let queue = Promise.resolve();
  const terminate = async () => {
    const owned = child;
    if (!owned) return;
    child = undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!owned.pid) return;
      try { process.kill(-owned.pid, signal); } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause;
      }
    };
    // close is the reaping boundary, including inherited stdio descriptors.
    const closed = exitWait;
    if (owned.exitCode !== null || owned.signalCode !== null) { kill('SIGKILL'); await closed; return; }
    owned.stdin?.end(); kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 300);
    try { await closed; } finally { clearTimeout(timer); kill('SIGKILL'); }
  };
  const reconcile = async () => {
    if (disposed || !enabled || !active.size) { await terminate(); return; }
    if (child) return;
    try {
      if (process.platform === 'win32') throw new Error('Windows is not implemented');
      const argv = config.command ?? inhibitorCommand(process.platform, config.mode);
      const executable = argv[0];
      if (!executable) throw new Error('command must contain a foreground executable');
      const started = spawn(executable, argv.slice(1), { detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
      child = started;
      exitWait = new Promise<void>((resolve) => started.once('close', () => resolve()));
      let detail = '';
      started.stderr?.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(-2048); });
      started.stdin?.on('error', () => undefined);
      started.once('error', (cause) => { error = cause.message; revision++; });
      started.once('close', (code, signal) => {
        if (child !== started) return;
        child = undefined;
        error = `Inhibitor exited (${signal ?? code}): ${detail.trim()}`;
        revision++;
      });
      await new Promise<void>((resolve, reject) => { started.once('spawn', resolve); started.once('error', reject); });
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      // A failed spawn still emits close; retain the handle until then or disposal.
    }
  };
  const enqueue = () => {
    const next = queue.then(reconcile);
    queue = next.catch((cause: unknown) => { error = cause instanceof Error ? cause.message : String(cause); });
    return queue;
  };
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') active.add(agent); else active.delete(agent);
    revision++; void enqueue();
  });
  ctx.on('agent/disposed', ({ agent }) => { active.delete(agent); revision++; void enqueue(); });
  for (const agent of ctx.agents.list()) if (agent.status === 'running') active.add(agent);
  void enqueue();
  ctx.effect(() => async () => { disposed = true; active.clear(); await enqueue(); });
  ctx.tools.register(defineTool({
    name: 'caffeinate',
    description: 'Inspect host sleep inhibition or explicitly enable/disable it. Agent running/idle/disposal events own the reference count. Status does not guarantee OS inhibition; inspect error. Updates need current revision.',
    parameters: { action: { type: 'string', enum: ['status', 'enable', 'disable'], required: true }, revision: { type: 'integer' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        revision: { type: 'integer', required: true }, enabled: { type: 'boolean', required: true },
        activeAgents: { type: 'integer', required: true }, pid: { type: 'integer', required: true },
        mode: { type: 'string', required: true }, error: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (disposed) throw new Error('Plugin disposed');
      if (args.action !== 'status') {
        if (args.revision !== revision) throw new Error(`Stale revision: expected ${revision}`);
        enabled = args.action === 'enable'; revision++; await enqueue();
      } else await queue;
      exec.signal.throwIfAborted();
      return { revision, enabled, activeAgents: active.size, pid: child?.pid ?? 0, mode: config.mode, error };
    },
  }));
}
