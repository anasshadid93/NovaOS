import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { audit } from '../db.js';
import { requireAuth, requireElevated } from '../auth/sessions.js';
import { docker, DockerError, followLogs, type ContainerSummary } from '../docker/client.js';
import type { WebSocket } from 'ws';
import { hub } from '../metrics/hub.js';
import { enqueue, getTask, hasActiveTask, listTasks, registerTask, taskCounts, type TaskStatus } from '../tasks/tasks.js';
import { catalog, summary } from './catalog.js';
import { appIcon, serviceIcon } from '../icons.js';
import { services } from '../launcher/launcher.js';
import { appUrl, installedApp, installedApps } from './installer.js';

const ICON_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const ID_RE = /^[a-f0-9]{12,64}$|^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function containerView(c: ContainerSummary) {
  return {
    id: c.Id.slice(0, 12),
    name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created * 1000,
    app: c.Labels['manar.app'] ?? null,
    project: c.Labels['com.docker.compose.project'] ?? null,
    ports: c.Ports.filter((p) => p.PublicPort).map((p) => ({ ip: p.IP, port: p.PublicPort, target: p.PrivatePort, proto: p.Type })),
  };
}

// Pull + recreate for compose projects not installed by Manar.
registerTask('compose.update', async (ctx, params) => {
  const dir = String(params.dir);
  const file = String(params.file);
  ctx.progress('Pulling new images');
  await ctx.run('docker', ['compose', '-f', file, 'pull'], { cwd: dir, timeoutMs: 60 * 60_000 });
  ctx.progress('Recreating containers');
  await ctx.run('docker', ['compose', '-f', file, 'up', '-d'], { cwd: dir });
});

registerTask('image.pull', async (ctx, params) => {
  await ctx.run('docker', ['pull', String(params.image)], { timeoutMs: 60 * 60_000 });
  ctx.log('Image pulled. Recreate the container to use it.');
});

export async function storeRoutes(app: FastifyInstance) {
  // Keep container names fresh for the process grouping (only if Docker is up).
  const refreshNames = async () => {
    if (!docker.socketExists()) return;
    try {
      hub.containerNames = new Map((await docker.list()).map((c) => [c.Id.slice(0, 12), c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12)]));
    } catch {
      /* docker down */
    }
  };
  void refreshNames();
  const t = setInterval(refreshNames, 30_000);
  t.unref();
  app.addHook('onClose', async () => clearInterval(t));

  const dockerError = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) =>
    reply.code(err instanceof DockerError ? (err.status === 404 ? 404 : 502) : 503).send({ error: 'docker', detail: (err as Error).message });

  // ---- Docker ------------------------------------------------------------
  app.get('/api/docker/status', { preHandler: requireAuth }, async () => docker.ping());

  app.get('/api/docker/containers', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      return (await docker.list()).map(containerView);
    } catch (err) {
      return dockerError(reply, err);
    }
  });

  // Docker samples ~1 s per container; with 30+ containers that was 8 s per request and the page
  // (polling every 5 s) never caught up. All containers at once, and while a refresh is running the
  // previous numbers are returned straight away.
  let statsCache: { at: number; data: Record<string, { cpu: number; mem: number; memLimit: number }> } | null = null;
  let statsJob: Promise<Record<string, { cpu: number; mem: number; memLimit: number }>> | null = null;
  const collectStats = async () => {
    const running = (await docker.list()).filter((c) => c.State === 'running');
    const out: Record<string, { cpu: number; mem: number; memLimit: number }> = {};
    await Promise.all(
      running.map(async (c) => {
        try {
          out[c.Id.slice(0, 12)] = await docker.stats(c.Id);
        } catch {
          /* container stopped meanwhile */
        }
      }),
    );
    statsCache = { at: Date.now(), data: out };
    return out;
  };
  app.get('/api/docker/stats', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      if (!statsJob) statsJob = collectStats().finally(() => (statsJob = null));
      if (statsCache && Date.now() - statsCache.at < 15_000) return statsCache.data;
      return await statsJob;
    } catch (err) {
      return dockerError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>('/api/docker/containers/:id/logs/live', { websocket: true, preHandler: requireAuth }, (socket: WebSocket, req) => {
    if (!ID_RE.test(req.params.id)) return socket.close(4400, 'bad_id');
    let stop: (() => void) | null = null;
    let closed = false;
    socket.on('close', () => {
      closed = true;
      stop?.();
    });
    void followLogs(req.params.id, Math.min(2000, Number(req.query.tail) || 300), (text) => {
      // Slow viewer: drop rather than buffer without bound.
      if (socket.readyState === socket.OPEN && socket.bufferedAmount < 2 * 1024 * 1024) socket.send(text);
    }, () => socket.readyState === socket.OPEN && socket.close(1000, 'ended'))
      .then((s) => (closed ? s() : (stop = s)))
      .catch(() => socket.close(4404, 'not_found'));
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>('/api/docker/containers/:id/logs', { preHandler: requireAuth }, async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
    try {
      return { logs: await docker.logs(req.params.id, Math.min(2000, Number(req.query.tail) || 300)) };
    } catch (err) {
      return dockerError(reply, err);
    }
  });

  app.post<{ Params: { id: string; action: string } }>('/api/docker/containers/:id/:action', async (req, reply) => {
    const { id, action } = req.params;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'bad_id' });
    // Starting is harmless; stopping/restarting/updating needs a fresh confirmation.
    if (action !== 'start') {
      await requireElevated(req, reply);
      if (reply.sent) return;
    } else {
      await requireAuth(req, reply);
      if (reply.sent) return;
    }
    try {
      if (action === 'start') await docker.start(id);
      else if (action === 'stop') await docker.stop(id);
      else if (action === 'restart') await docker.restart(id);
      else if (action === 'update') {
        const info = (await docker.inspect(id)) as { Config: { Image: string; Labels: Record<string, string> } };
        const labels = info.Config.Labels ?? {};
        let taskId: number;
        if (labels['manar.app']) taskId = enqueue('app.update', `Update ${labels['manar.app']}`, { id: labels['manar.app'] }, labels['manar.app']);
        else if (labels['com.docker.compose.project.working_dir'] && labels['com.docker.compose.project.config_files']) {
          const dir = labels['com.docker.compose.project.working_dir'];
          const file = labels['com.docker.compose.project.config_files'].split(',')[0];
          if (!fs.existsSync(path.resolve(dir, file))) return reply.code(409).send({ error: 'compose_file_missing' });
          taskId = enqueue('compose.update', `Update ${labels['com.docker.compose.project']}`, { dir, file });
        } else taskId = enqueue('image.pull', `Pull ${info.Config.Image}`, { image: info.Config.Image });
        return { task: taskId };
      } else return reply.code(400).send({ error: 'bad_action' });
    } catch (err) {
      return dockerError(reply, err);
    }
    audit(req.session!.userId, `container_${action}`, { id });
    return { ok: true };
  });

  // ---- Store -------------------------------------------------------------
  app.get('/api/store/apps', { preHandler: requireAuth }, async () => {
    const installed = new Map(installedApps().map((a) => [a.id, a.status]));
    const c = catalog();
    return {
      source: c.source,
      categories: [...new Set(c.apps.map((a) => a.category))].sort(),
      apps: c.apps.map((a) => ({ ...summary(a), installed: installed.get(a.id) ?? null })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/store/apps/:id', { preHandler: requireAuth }, async (req, reply) => {
    const a = catalog().byId.get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'not_found' });
    const services = Object.entries(a.compose.services).map(([name, s]) => ({ name, image: String(s.image ?? '') }));
    const inst = installedApp(a.id);
    return {
      ...summary(a),
      description: a.description,
      developer: a.developer,
      tips: a.tips,
      services,
      source: a.source,
      installed: inst ? { status: inst.status, url: appUrl(inst) } : null,
      busy: hasActiveTask(a.id),
    };
  });

  app.post<{ Params: { id: string } }>('/api/store/apps/:id/install', { preHandler: requireAuth }, async (req, reply) => {
    const a = catalog().byId.get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'not_found' });
    if (installedApp(a.id)) return reply.code(409).send({ error: 'already_installed' });
    if (hasActiveTask(a.id)) return reply.code(409).send({ error: 'busy' });
    const ping = await docker.ping();
    if (!ping.ok) return reply.code(503).send({ error: 'docker_unavailable', detail: ping.error });
    audit(req.session!.userId, 'app_install', { id: a.id });
    return { task: enqueue('app.install', `Install ${a.title}`, { id: a.id }, a.id) };
  });

  // ---- Installed apps ------------------------------------------------------
  app.get('/api/apps', { preHandler: requireAuth }, async () => {
    let states = new Map<string, string>();
    try {
      if (docker.socketExists()) {
        for (const c of await docker.list()) {
          const id = c.Labels['manar.app'];
          if (id && (c.Labels['manar.service'] === undefined || !states.has(id) || c.State !== 'running')) states.set(id, c.State);
        }
      }
    } catch {
      states = new Map();
    }
    return installedApps().map((a) => ({
      id: a.id,
      title: a.title,
      icon: a.icon,
      status: a.status,
      state: states.get(a.id) ?? null,
      url: appUrl(a),
      canRollback: !!a.prev_images,
      busy: hasActiveTask(a.id),
      installedAt: a.installed_at,
      updatedAt: a.updated_at,
    }));
  });

  app.post<{ Params: { id: string } }>('/api/apps/:id/update', { preHandler: requireElevated }, async (req, reply) => {
    const a = installedApp(req.params.id);
    if (!a) return reply.code(404).send({ error: 'not_found' });
    if (hasActiveTask(a.id)) return reply.code(409).send({ error: 'busy' });
    return { task: enqueue('app.update', `Update ${a.title}`, { id: a.id }, a.id) };
  });

  app.post<{ Params: { id: string } }>('/api/apps/:id/rollback', { preHandler: requireElevated }, async (req, reply) => {
    const a = installedApp(req.params.id);
    if (!a?.prev_images) return reply.code(404).send({ error: 'nothing_to_rollback' });
    if (hasActiveTask(a.id)) return reply.code(409).send({ error: 'busy' });
    return { task: enqueue('app.rollback', `Roll back ${a.title}`, { id: a.id }, a.id) };
  });

  app.delete<{ Params: { id: string }; Body: { deleteData?: boolean; confirmName?: string } }>(
    '/api/apps/:id',
    { preHandler: requireElevated },
    async (req, reply) => {
      const a = installedApp(req.params.id);
      if (!a) return reply.code(404).send({ error: 'not_found' });
      if (hasActiveTask(a.id)) return reply.code(409).send({ error: 'busy' });
      const deleteData = req.body?.deleteData === true;
      // Deleting data is irreversible: the client must send the app id typed by the user.
      if (deleteData && req.body?.confirmName !== a.id) return reply.code(400).send({ error: 'confirm_name' });
      audit(req.session!.userId, 'app_remove', { id: a.id, deleteData });
      return { task: enqueue('app.remove', `Remove ${a.title}`, { id: a.id, deleteData }, a.id) };
    },
  );

  // ---- Tasks -------------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>('/api/tasks', { preHandler: requireAuth }, async (req) => {
    const s = req.query.status as TaskStatus | undefined;
    return { counts: taskCounts(), tasks: listTasks(s && ['queued', 'running', 'failed', 'succeeded'].includes(s) ? s : undefined) };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', { preHandler: requireAuth }, async (req, reply) => {
    const t = getTask(Number(req.params.id));
    return t ?? reply.code(404).send({ error: 'not_found' });
  });

  // ---- App logos (see icons.ts), cached on disk -------------------------------
  const sendImg = (reply: FastifyReply, img: { buf: Buffer; type: string } | null) =>
    img
      ? reply
          .header('Content-Type', img.type)
          .header('Cache-Control', 'public, max-age=86400')
          // SVGs can contain script: never let one run in Manar's origin.
          .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
          .send(img.buf)
      : reply.code(404).send({ error: 'not_found' });

  app.get<{ Params: { name: string } }>('/api/icons/:name', { preHandler: requireAuth }, async (req, reply) => {
    const name = req.params.name.replace(/\.png$/, '');
    if (!ICON_RE.test(name)) return reply.code(400).send({ error: 'bad_name' });
    const entry = catalog().apps.find((a) => a.icon === name);
    return sendImg(reply, await appIcon(name, (entry as { iconUrl?: string } | undefined)?.iconUrl ?? null));
  });

  /** Installed app: the icon the running app publishes itself; catalog logo as fallback. */
  app.get<{ Params: { id: string } }>('/api/icons/app/:id', { preHandler: requireAuth }, async (req, reply) => {
    const inst = installedApp(req.params.id);
    if (!inst) return reply.code(404).send({ error: 'not_found' });
    // Server-run ArtCraft desktop builds: the app's own icon from ~/ArtCraft.
    if (inst.icon?.startsWith('craft:')) {
      const file = path.join(config.craftRoot, inst.icon.slice(6).replace(/[^a-z0-9-]/g, ''), 'icon.webp');
      if (fs.existsSync(file)) return sendImg(reply, { buf: fs.readFileSync(file), type: 'image/webp' });
    }
    let img = inst.web_port ? await serviceIcon(`app-${inst.id}`, `http://127.0.0.1:${inst.web_port}`) : null;
    if (!img && inst.icon) {
      const entry = catalog().byId.get(inst.id) as { iconUrl?: string } | undefined;
      img = await appIcon(inst.icon, entry?.iconUrl ?? null);
    }
    return sendImg(reply, img);
  });

  app.get<{ Params: { id: string } }>('/api/icons/svc/:id', { preHandler: requireAuth }, async (req, reply) => {
    const svc = services().find((s) => s.id === req.params.id);
    if (!svc?.local) return reply.code(404).send({ error: 'not_found' });
    return sendImg(reply, await serviceIcon(svc.id, svc.local));
  });
}
