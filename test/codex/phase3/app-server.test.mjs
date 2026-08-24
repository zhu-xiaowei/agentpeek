import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'stream';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { CodexAppServerClient } from '../../../bridge/codex-app-server.mjs';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new Writable({
    write(chunk, _encoding, done) {
      proc.writes.push(JSON.parse(chunk.toString()));
      done();
    },
    final(done) {
      done();
      queueMicrotask(() => proc.emit('close', 0, null));
    },
  });
  proc.writes = [];
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.emit('close', 0, 'SIGTERM');
  };
  return proc;
}

async function waitForWrite(proc, method) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const message = proc.writes.find((entry) => entry.method === method);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`missing write for ${method}`);
}

async function waitForMessage(appServer, predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const message = appServer.messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('missing managed app-server message');
}

async function fakeUnixAppServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-codex-ws-'));
  const socketPath = path.join(dir, 'app-server.sock');
  const messages = [];
  let connection = null;
  const server = http.createServer();
  const webSockets = new WebSocketServer({ server });
  webSockets.on('connection', (socket) => {
    connection = socket;
    socket.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise((resolve) => webSockets.close(resolve));
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    socketPath,
    messages,
    send(message) {
      connection.send(JSON.stringify(message));
    },
  };
}

test('app-server client initializes and pairs interleaved responses', async (t) => {
  const proc = fakeProcess();
  const client = new CodexAppServerClient({
    bin: '/fake/codex',
    spawnFn: () => proc,
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const started = client.start();
  const init = await waitForWrite(proc, 'initialize');
  proc.stdout.write(`${JSON.stringify({ id: init.id, result: { userAgent: 'test' } })}\n`);
  await started;
  assert.ok(proc.writes.some((entry) => entry.method === 'initialized'));

  const first = client.request('thread/resume', { threadId: 'thread-1' });
  const second = client.request('thread/read', { threadId: 'thread-2' });
  const resume = await waitForWrite(proc, 'thread/resume');
  const read = await waitForWrite(proc, 'thread/read');
  proc.stdout.write(`${JSON.stringify({ id: read.id, result: { thread: { id: 'thread-2' } } })}\n`);
  proc.stdout.write(`${JSON.stringify({ id: resume.id, result: { thread: { id: 'thread-1' } } })}\n`);

  assert.equal((await first).thread.id, 'thread-1');
  assert.equal((await second).thread.id, 'thread-2');
});

test('app-server client reuses a managed Unix WebSocket daemon', async (t) => {
  const appServer = await fakeUnixAppServer(t);
  const client = new CodexAppServerClient({
    socketPath: appServer.socketPath,
    requestTimeout: 1000,
    spawnFn() {
      throw new Error('stdio fallback should not be used');
    },
  });
  t.after(() => client.stop());

  const started = client.start();
  const initialize = await waitForMessage(
    appServer,
    (message) => message.method === 'initialize',
  );
  appServer.send({ id: initialize.id, result: { userAgent: 'managed-daemon' } });
  await started;
  await waitForMessage(appServer, (message) => message.method === 'initialized');

  const resumed = client.request('thread/resume', {
    threadId: 'thread-managed',
    excludeTurns: true,
  });
  const resume = await waitForMessage(
    appServer,
    (message) => message.method === 'thread/resume',
  );
  appServer.send({
    id: resume.id,
    result: {
      thread: {
        id: 'thread-managed',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      },
    },
  });
  assert.equal((await resumed).thread.id, 'thread-managed');

  const requests = [];
  client.on('serverRequest', (request) => requests.push(request));
  appServer.send({
    id: 21,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-managed', turnId: 'turn-active' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests[0].id, 21);

  client.respond(21, { decision: 'cancel' });
  await waitForMessage(
    appServer,
    (message) => message.id === 21 && message.result?.decision === 'cancel',
  );
});

test('managed-only app-server client never falls back to stdio', async () => {
  let spawned = false;
  const client = new CodexAppServerClient({
    socketPath: false,
    managedOnly: true,
    spawnFn() {
      spawned = true;
      return fakeProcess();
    },
  });

  await assert.rejects(client.start(), /Managed Codex app-server is unavailable/);
  assert.equal(spawned, false);
});

test('managed socket failure falls back to a stdio app-server', async (t) => {
  const proc = fakeProcess();
  const client = new CodexAppServerClient({
    bin: '/fake/codex',
    socketPath: path.join(os.tmpdir(), `missing-${randomUUID()}.sock`),
    spawnFn: () => proc,
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const started = client.start();
  const initialize = await waitForWrite(proc, 'initialize');
  proc.stdout.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await started;
  assert.deepEqual(proc.writes.map((message) => message.method), [
    'initialize',
    'initialized',
  ]);
});

test('Windows Codex cmd shim is spawned through the shell with Node on PATH', async (t) => {
  const proc = fakeProcess();
  let call;
  const client = new CodexAppServerClient({
    bin: 'C:\\Program Files\\nodejs\\codex.cmd',
    platform: 'win32',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    spawnFn(binary, args, options) {
      call = { binary, args, options };
      return proc;
    },
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const started = client.start();
  const init = await waitForWrite(proc, 'initialize');
  proc.stdout.write(`${JSON.stringify({ id: init.id, result: {} })}\n`);
  await started;

  assert.equal(call.binary, '"C:\\Program Files\\nodejs\\codex.cmd"');
  assert.deepEqual(call.args, ['app-server', '--stdio']);
  assert.equal(call.options.shell, true);
  assert.equal(call.options.windowsHide, true);
  const pathKey = Object.keys(call.options.env)
    .find((key) => key.toLowerCase() === 'path');
  assert.ok(call.options.env[pathKey].startsWith('C:\\Program Files\\nodejs;'));
});

test('app-server client dispatches notifications and server requests', async (t) => {
  const proc = fakeProcess();
  const client = new CodexAppServerClient({
    bin: '/fake/codex',
    spawnFn: () => proc,
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const started = client.start();
  const init = await waitForWrite(proc, 'initialize');
  proc.stdout.write(`${JSON.stringify({ id: init.id, result: {} })}\n`);
  await started;

  const notifications = [];
  const errors = [];
  const requests = [];
  client.on('item/agentMessage/delta', (params) => notifications.push(params));
  client.on('codexError', (params) => errors.push(params));
  client.on('serverRequest', (request) => requests.push(request));
  proc.stdout.write(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 't', turnId: 'v', itemId: 'i', delta: 'hello' },
  })}\n`);
  proc.stdout.write(`${JSON.stringify({
    id: 99,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't', turnId: 'v', itemId: 'i' },
  })}\n`);
  proc.stdout.write(`${JSON.stringify({
    method: 'error',
    params: {
      threadId: 't',
      turnId: 'v',
      error: { message: 'model failed' },
      willRetry: false,
    },
  })}\n`);

  assert.equal(notifications[0].delta, 'hello');
  assert.equal(errors[0].error.message, 'model failed');
  assert.equal(requests[0].id, 99);
  client.respond(99, { decision: 'decline' });
  assert.deepEqual(proc.writes.at(-1), { id: 99, result: { decision: 'decline' } });
});

test('concurrent starts share initialization before later requests are written', async (t) => {
  const proc = fakeProcess();
  const client = new CodexAppServerClient({
    bin: '/fake/codex',
    spawnFn: () => proc,
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const first = client.request('thread/resume', { threadId: 'thread-1' });
  const second = client.request('thread/resume', { threadId: 'thread-2' });
  const init = await waitForWrite(proc, 'initialize');
  assert.deepEqual(proc.writes.map((message) => message.method), ['initialize']);

  proc.stdout.write(`${JSON.stringify({ id: init.id, result: {} })}\n`);
  const resumes = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    resumes.splice(0, resumes.length, ...proc.writes.filter((entry) =>
      entry.method === 'thread/resume'
    ));
    if (resumes.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(resumes.length, 2);
  for (const request of resumes) {
    proc.stdout.write(`${JSON.stringify({
      id: request.id,
      result: { thread: { id: request.params.threadId } },
    })}\n`);
  }
  assert.equal((await first).thread.id, 'thread-1');
  assert.equal((await second).thread.id, 'thread-2');
});
