import type { FastifyInstance, FastifyReply } from 'fastify';
import { audit } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { ConfigError, getEnv, readCompose, saveCompose, setEnv, setServiceOptions } from '../store/appconfig.js';
import { installedApp } from '../store/installer.js';
import { enqueue, hasActiveTask } from '../tasks/tasks.js';
import { docker, DockerError } from './client.js';

/** Per-container details, settings and removal; Docker images. */

const ID_RE = /^[a-f0-9]{12,64}$|^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const RESTART = ['no', 'always', 'unless-stopped', 'on-failure'];
const SECRET_KEY = /(PASS(WORD)?|PASSWD|SECRET|TOKEN|API_?KEY|SALT|PRIVATE_?KEY)/i;

interface Inspect {
  Id: string;
  Name: string;
  Created: string;
  Path: string;
  Args: string[];
  State: { Status: string; Running: boolean; StartedAt: string; FinishedAt: string; ExitCode: number; Health?: { Status: string } };
  RestartCount: number;
  Config: { Image: string; Env: string[] | null; Labels: Record<string, string>; Cmd: string[] | null; Entrypoint: string[] | null; WorkingDir: string; User: string };
  HostConfig: { RestartPolicy: { Name: string; MaximumRetryCount: number }; Memory: number; NanoCpus: number; Privileged: boolean; NetworkMode: string };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null>; Networks: Record<string, { IPAddress: string }> };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[];
}

function err(reply: FastifyReply, e: unknown) {
  if (e instanceof ConfigError) return reply.code(400).send({ error: e.code, detail: e.detail });
  if (e instanceof DockerError) return reply.code(e.status === 404 ? 404 : e.status === 409 ? 409 : 502).send({ error: 'docker', detail: e.message });
  throw e;
}

export async function dockerManageRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/docker/containers/:id/info', { preHandler: requireAuth }, async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
    try {
      const c = (await docker.inspect(req.params.id)) as unknown as Inspect;
      const appId = c.Config.Labels['manar.app'] ?? null;
      const service = c.Config.Labels['manar.service'] ?? c.Config.Labels['com.docker.compose.service'] ?? null;
      return {
        id: c.Id.slice(0, 12),
        name: c.Name.replace(/^\//, ''),
        image: c.Config.Image,
        created: Date.parse(c.Created),
        state: { status: c.State.Status, running: c.State.Running, startedAt: Date.parse(c.State.StartedAt), exitCode: c.State.ExitCode, health: c.State.Health?.Status ?? null, restarts: c.RestartCount },
        command: [...(c.Config.Entrypoint ?? []), ...(c.Config.Cmd ?? [])].join(' '),
        workingDir: c.Config.WorkingDir,
        user: c.Config.User,
        restartPolicy: c.HostConfig.RestartPolicy.Name || 'no',
        memory: c.HostConfig.Memory,
        cpus: c.HostConfig.NanoCpus / 1e9,
        privileged: c.HostConfig.Privileged,
        networkMode: c.HostConfig.NetworkMode,
        networks: Object.entries(c.NetworkSettings.Networks ?? {}).map(([n, v]) => ({ name: n, ip: v.IPAddress })),
        ports: Object.entries(c.NetworkSettings.Ports ?? {}).flatMap(([target, binds]) => (binds ?? [{ HostIp: '', HostPort: '' }]).map((b) => ({ target, hostIp: b.HostIp, hostPort: b.HostPort }))),
        mounts: c.Mounts.map((m) => ({ type: m.Type, source: m.Type === 'volume' ? (m.Name ?? m.Source) : m.Source, destination: m.Destination, rw: m.RW })),
        // Secret-looking values are masked here; the app's Environment editor reveals them after a confirmation.
        env: (c.Config.Env ?? []).map((e) => {
          const i = e.indexOf('=');
          const key = e.slice(0, i);
          return { key, value: SECRET_KEY.test(key) ? null : e.slice(i + 1) };
        }),
        labels: c.Config.Labels,
        app: appId ? { id: appId, service, managed: !!installedApp(appId) } : null,
        compose: c.Config.Labels['com.docker.compose.project'] ?? null,
      };
    } catch (e) {
      return err(reply, e);
    }
  });

  /** Restart policy and limits. Manar apps: written to compose.yaml and re-applied. Others: live `docker update`. */
  app.post<{ Params: { id: string }; Body: { restart?: string; memory?: number | null; cpus?: number | null } }>(
    '/api/docker/containers/:id/settings',
    { preHandler: requireElevated },
    async (req, reply) => {
      const { restart, memory, cpus } = req.body ?? {};
      if (restart !== undefined && !RESTART.includes(restart)) return reply.code(400).send({ error: 'bad_restart' });
      if (memory !== undefined && memory !== null && (!Number.isFinite(memory) || memory < 6 * 1024 ** 2)) return reply.code(400).send({ error: 'bad_memory' });
      if (cpus !== undefined && cpus !== null && (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64)) return reply.code(400).send({ error: 'bad_cpus' });
      try {
        const c = (await docker.inspect(req.params.id)) as unknown as Inspect;
        const appId = c.Config.Labels['manar.app'];
        if (appId && installedApp(appId)) {
          if (hasActiveTask(appId)) return reply.code(409).send({ error: 'busy' });
          await setServiceOptions(appId, c.Config.Labels['manar.service'], { restart, memory, cpus });
          audit(req.session!.userId, 'container_settings', { app: appId, restart, memory, cpus });
          return { task: enqueue('app.apply', `Apply settings: ${appId}`, { id: appId }, appId) };
        }
        await docker.update(c.Id, {
          ...(restart !== undefined ? { RestartPolicy: { Name: restart === 'no' ? '' : restart, ...(restart === 'on-failure' ? { MaximumRetryCount: 5 } : {}) } } : {}),
          ...(memory !== undefined ? { Memory: memory ?? 0, MemorySwap: memory ? memory * 2 : 0 } : {}),
          ...(cpus !== undefined ? { NanoCpus: Math.round((cpus ?? 0) * 1e9) } : {}),
        });
        audit(req.session!.userId, 'container_settings', { id: req.params.id, restart, memory, cpus });
        return { ok: true };
      } catch (e) {
        return err(reply, e);
      }
    },
  );

  app.delete<{ Params: { id: string }; Body: { volumes?: boolean } }>('/api/docker/containers/:id', { preHandler: requireElevated }, async (req, reply) => {
    try {
      const c = (await docker.inspect(req.params.id)) as unknown as Inspect;
      const appId = c.Config.Labels['manar.app'];
      // Manar apps are removed as a whole (compose project, Tailscale port, data choice).
      if (appId && installedApp(appId)) return reply.code(409).send({ error: 'is_app', app: appId });
      await docker.remove(c.Id, req.body?.volumes === true);
      audit(req.session!.userId, 'container_remove', { name: c.Name, volumes: req.body?.volumes === true });
      return { ok: true };
    } catch (e) {
      return err(reply, e);
    }
  });

  // ---- App configuration (compose.yaml / env) --------------------------------
  const appOr404 = (id: string, reply: FastifyReply) => {
    const a = installedApp(id);
    if (!a) reply.code(404).send({ error: 'not_found' });
    return a;
  };

  app.get<{ Params: { id: string } }>('/api/apps/:id/env', { preHandler: requireAuth }, async (req, reply) => {
    if (!appOr404(req.params.id, reply)) return;
    try {
      return getEnv(req.params.id, false);
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/apps/:id/env/reveal', { preHandler: requireElevated }, async (req, reply) => {
    if (!appOr404(req.params.id, reply)) return;
    audit(req.session!.userId, 'app_env_reveal', { id: req.params.id });
    return getEnv(req.params.id, true);
  });

  app.put<{ Params: { id: string }; Body: { service: string; vars: { key: string; value: string | null }[] } }>(
    '/api/apps/:id/env',
    { preHandler: requireElevated },
    async (req, reply) => {
      const id = req.params.id;
      if (!appOr404(id, reply)) return;
      if (hasActiveTask(id)) return reply.code(409).send({ error: 'busy' });
      if (!Array.isArray(req.body?.vars) || req.body.vars.length > 200) return reply.code(400).send({ error: 'bad_args' });
      try {
        await setEnv(id, String(req.body.service), req.body.vars);
      } catch (e) {
        return err(reply, e);
      }
      audit(req.session!.userId, 'app_env_set', { id, service: req.body.service, keys: req.body.vars.map((v) => v.key) });
      return { task: enqueue('app.apply', `Apply environment: ${id}`, { id }, id) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/apps/:id/compose', { preHandler: requireElevated }, async (req, reply) => {
    if (!appOr404(req.params.id, reply)) return;
    try {
      return { text: readCompose(req.params.id) };
    } catch (e) {
      return err(reply, e);
    }
  });

  app.put<{ Params: { id: string }; Body: { text: string } }>('/api/apps/:id/compose', { preHandler: requireElevated }, async (req, reply) => {
    const id = req.params.id;
    if (!appOr404(id, reply)) return;
    if (hasActiveTask(id)) return reply.code(409).send({ error: 'busy' });
    const text = String(req.body?.text ?? '');
    if (text.length > 200_000) return reply.code(413).send({ error: 'too_large' });
    try {
      await saveCompose(id, text);
    } catch (e) {
      return err(reply, e);
    }
    audit(req.session!.userId, 'app_compose_edit', { id });
    return { task: enqueue('app.apply', `Apply compose.yaml: ${id}`, { id }, id) };
  });

  // ---- Images ------------------------------------------------------------------
  app.get('/api/docker/images', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      const [imgs, ctrs] = await Promise.all([docker.images(), docker.list()]);
      const used = new Map<string, string[]>();
      for (const c of ctrs) used.set(c.ImageID, [...(used.get(c.ImageID) ?? []), c.Names[0]?.replace(/^\//, '') ?? '']);
      return imgs
        .map((i) => ({ id: i.Id.replace(/^sha256:/, '').slice(0, 12), fullId: i.Id, tags: i.RepoTags?.filter((t) => t !== '<none>:<none>') ?? [], size: i.Size, created: i.Created * 1000, usedBy: used.get(i.Id) ?? [] }))
        .sort((a, b) => b.size - a.size);
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/docker/images/:id', { preHandler: requireElevated }, async (req, reply) => {
    if (!/^(sha256:)?[a-f0-9]{12,64}$/.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
    try {
      await docker.removeImage(req.params.id, false);
      audit(req.session!.userId, 'image_remove', { id: req.params.id });
      return { ok: true };
    } catch (e) {
      if (e instanceof DockerError && e.status === 409) return reply.code(409).send({ error: 'in_use' });
      return err(reply, e);
    }
  });

  app.post<{ Body: { all?: boolean } }>('/api/docker/images/prune', { preHandler: requireElevated }, async (req, reply) => {
    try {
      const r = await docker.pruneImages(req.body?.all === true);
      audit(req.session!.userId, 'image_prune', { all: req.body?.all === true, reclaimed: r.SpaceReclaimed });
      return { deleted: r.ImagesDeleted?.length ?? 0, reclaimed: r.SpaceReclaimed };
    } catch (e) {
      return err(reply, e);
    }
  });
}
