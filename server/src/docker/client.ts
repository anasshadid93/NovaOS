import fs from 'node:fs';
import http from 'node:http';
import { config } from '../config.js';

/** Minimal Docker Engine API client over the unix socket (no extra dependency). */

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const API = '/v1.43';

function request(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: config.dockerSocket, method, path: API + path, headers: body ? { 'Content-Type': 'application/json' } : undefined, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new DockerError(504, 'docker_timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function json<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const { status, buf } = await request(method, path, body, timeoutMs);
  if (status >= 400) {
    let msg = buf.toString();
    try {
      msg = (JSON.parse(msg) as { message: string }).message;
    } catch {
      /* raw */
    }
    throw new DockerError(status, msg);
  }
  return (buf.length ? JSON.parse(buf.toString()) : undefined) as T;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Status: string;
  Created: number;
  Labels: Record<string, string>;
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
}

export const docker = {
  socketExists: () => fs.existsSync(config.dockerSocket),

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    if (!fs.existsSync(config.dockerSocket)) return { ok: false, error: 'no_socket' };
    try {
      const v = await json<{ Version: string }>('GET', '/version', undefined, 3000);
      return { ok: true, version: v.Version };
    } catch (err) {
      return { ok: false, error: (err as NodeJS.ErrnoException).code === 'EACCES' ? 'permission' : 'unreachable' };
    }
  },

  list: () => json<ContainerSummary[]>('GET', '/containers/json?all=1'),
  inspect: (id: string) => json<Record<string, unknown>>('GET', `/containers/${encodeURIComponent(id)}/json`),
  start: (id: string) => json('POST', `/containers/${encodeURIComponent(id)}/start`),
  stop: (id: string) => json('POST', `/containers/${encodeURIComponent(id)}/stop?t=15`, undefined, 30_000),
  restart: (id: string) => json('POST', `/containers/${encodeURIComponent(id)}/restart?t=15`, undefined, 30_000),
  /** What the registry currently serves for this reference (digest), without pulling. */
  distribution: (ref: string) => json<{ Descriptor: { digest: string } }>('GET', `/distribution/${encodeURIComponent(ref)}/json`, undefined, 15_000),
  imageInspect: (ref: string) => json<{ Id: string; RepoTags: string[]; RepoDigests: string[] }>('GET', `/images/${encodeURIComponent(ref)}/json`),
  tag: (image: string, repo: string, tag: string) =>
    json('POST', `/images/${encodeURIComponent(image)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`),

  /** Live-update restart policy / limits (no recreate needed). */
  update: (id: string, body: { RestartPolicy?: { Name: string; MaximumRetryCount?: number }; Memory?: number; MemorySwap?: number; NanoCpus?: number }) =>
    json('POST', `/containers/${encodeURIComponent(id)}/update`, body),
  remove: (id: string, volumes: boolean) => json('DELETE', `/containers/${encodeURIComponent(id)}?force=1${volumes ? '&v=1' : ''}`, undefined, 60_000),
  images: () => json<{ Id: string; RepoTags: string[] | null; Size: number; Created: number; Containers: number }[]>('GET', '/images/json?all=0'),
  removeImage: (id: string, force: boolean) => json<unknown[]>('DELETE', `/images/${encodeURIComponent(id)}${force ? '?force=1' : ''}`, undefined, 60_000),
  pruneImages: (all: boolean) =>
    json<{ ImagesDeleted: unknown[] | null; SpaceReclaimed: number }>('POST', `/images/prune${all ? `?filters=${encodeURIComponent(JSON.stringify({ dangling: ['false'] }))}` : ''}`, undefined, 120_000),

  /** One-shot stats (Docker samples ~1 s internally). */
  async stats(id: string) {
    const s = await json<{
      cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus: number };
      precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
      memory_stats: { usage?: number; stats?: { inactive_file?: number }; limit?: number };
    }>('GET', `/containers/${encodeURIComponent(id)}/stats?stream=false`, undefined, 8000);
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
    const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage ?? 0);
    const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus || 1) * 100 : 0;
    const mem = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.inactive_file ?? 0);
    return { cpu: Math.round(cpu * 10) / 10, mem: Math.max(0, mem), memLimit: s.memory_stats.limit ?? 0 };
  },

  /** Last N log lines, de-multiplexed (non-TTY containers frame stdout/stderr). */
  async logs(id: string, tail = 300): Promise<string> {
    const info = (await this.inspect(id)) as { Config?: { Tty?: boolean } };
    const { status, buf } = await request('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
    if (status >= 400) throw new DockerError(status, buf.toString());
    return info.Config?.Tty ? buf.toString() : demux(buf);
  },
};

/**
 * Follow a container's logs: calls `onText` with each new piece (stdout and stderr, de-multiplexed
 * for non-TTY containers). Returns a function that stops following.
 */
export async function followLogs(id: string, tail: number, onText: (s: string) => void, onEnd: () => void): Promise<() => void> {
  const info = (await docker.inspect(id)) as { Config?: { Tty?: boolean } };
  const tty = !!info.Config?.Tty;
  let pending = Buffer.alloc(0);
  const req = http.request({ socketPath: config.dockerSocket, method: 'GET', path: `${API}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&follow=1&tail=${tail}` }, (res) => {
    res.on('data', (c: Buffer) => {
      if (tty) return onText(c.toString());
      // Frames may be split across chunks: keep the remainder for the next one.
      pending = Buffer.concat([pending, c]);
      const out: string[] = [];
      while (pending.length >= 8) {
        const len = pending.readUInt32BE(4);
        if (pending.length < 8 + len) break;
        out.push(pending.subarray(8, 8 + len).toString());
        pending = pending.subarray(8 + len);
      }
      if (out.length) onText(out.join(''));
    });
    res.on('end', onEnd);
    res.on('error', onEnd);
  });
  req.on('error', onEnd);
  req.end();
  return () => req.destroy();
}

export function demux(buf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + len).toString());
    i += 8 + len;
  }
  return out.join('');
}
