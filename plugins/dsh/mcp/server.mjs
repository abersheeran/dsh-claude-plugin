#!/usr/bin/env node
/**
 * dsh-subagent — a Model Context Protocol server that lets Claude Code drive
 * DeepSeek Harness (DSH) sessions over the DSH SDK stdio protocol.
 *
 * One persistent `dsh --profile sdk` process per DSH session gives:
 *   - multi-turn follow-ups in the same conversation,
 *   - mid-run interjections (queued at the next turn boundary),
 *   - hard interruption (stop the runtime, then resume the persisted session),
 *   - resume across Claude Code restarts through DSH's durable sessions.
 *
 * The server has no npm dependencies: MCP's stdio transport and DSH's SDK
 * transport are both newline-delimited JSON-RPC 2.0, implemented here directly.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const SERVER_NAME = 'dsh-subagent';
const SERVER_VERSION = '0.2.0';

const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 10 * 1000;
const MAX_TIMEOUT_MS = 55 * 60 * 1000;
const INIT_TIMEOUT_MS = 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const STDERR_LIMIT = 64 * 1024;
const ANSWER_LIMIT = 4 * 1024 * 1024;
const ASSISTANT_HISTORY = 60;
const DEFAULT_MAX_SESSIONS = 8;

const MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const DEFAULT_MODE = 'workspace-write';

/** Environment variables the parent DSH surface may set; they must not leak
 *  into a nested DSH runtime. */
const SCRUBBED_ENV = ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'DSH_SHELL'];

const AUTH_HINT = [
  'DSH could not authenticate with the model provider.',
  '',
  'Do one of these, then retry:',
  '  • Sign in to the DeepSeek Harness desktop app — the plugin reuses the saved account.',
  '  • Export DEEPSEEK_API_KEY before starting Claude Code (for example in ~/.zshrc).',
  '  • Set DSH_SUBAGENT_PROVIDER (and optionally DSH_SUBAGENT_MODEL) to another configured DSH route.',
].join('\n');

const DSH_NOT_FOUND = [
  'DeepSeek Harness CLI not found.',
  '',
  'The plugin looks for:',
  '  1. the DSH_BIN environment variable,',
  '  2. an executable named `dsh` on PATH,',
  '  3. /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh (macOS).',
  '',
  'Install DeepSeek Harness, or set DSH_BIN to the path of its `dsh` launcher, then restart Claude Code.',
].join('\n');

class DshTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DshTimeoutError';
  }
}

class DshCancelledError extends Error {
  constructor(message = 'Request cancelled') {
    super(message);
    this.name = 'DshCancelledError';
  }
}

class DshRuntimeError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'DshRuntimeError';
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function envString(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function debug(...args) {
  if (envString('DSH_SUBAGENT_DEBUG') === '1') {
    console.error('[dsh-subagent]', ...args);
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function appendBounded(current, chunk, limit) {
  const next = current + chunk;
  return next.length > limit ? next.slice(-limit) : next;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function oneLine(text, limit) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…` : value;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function formatTime(value) {
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const date = new Date(milliseconds);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function looksLikeAuthFailure(text) {
  return /MISSING_CREDENTIAL|no API key|unauthorized|\b401\b|invalid token|sign in|no adapter registered/i.test(text);
}

function cleanDiagnostics(stderr, message) {
  const messageText = String(message ?? '').trim();
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !/^\[llm-/.test(trimmed) && (messageText === '' || !trimmed.includes(messageText));
    });
  if (lines.length === 0) return '';
  const joined = lines.join('\n');
  return joined.length > 4000 ? `${joined.slice(-4000)}\n…` : joined;
}

function failureText(message, stderr, sessionId) {
  const parts = [`DSH subagent failed: ${message}`];
  if (looksLikeAuthFailure(`${message}\n${stderr ?? ''}`)) {
    parts.push('', AUTH_HINT);
  }
  const details = cleanDiagnostics(stderr ?? '', message);
  if (details) parts.push('', 'Diagnostics:', details);
  if (sessionId) parts.push('', sessionFooter(sessionId));
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Locating DSH and credentials
// ---------------------------------------------------------------------------

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveDshBin() {
  const explicit = envString('DSH_BIN');
  if (explicit) {
    if (explicit.includes('/') || explicit.includes('\\')) {
      if (isExecutableFile(explicit)) return explicit;
      throw new DshRuntimeError(`DSH_BIN is set to "${explicit}", but that is not an executable file.`);
    }
    const found = findOnPath([explicit]);
    if (found) return found;
    throw new DshRuntimeError(`DSH_BIN is set to "${explicit}", but no executable with that name is on PATH.`);
  }

  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  const onPath = findOnPath(names);
  if (onPath) return onPath;

  if (process.platform === 'darwin') {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      const candidate = join(
        base,
        'DeepSeek Harness.app',
        'Contents',
        'Resources',
        'runtime',
        'cli',
        'bin',
        'dsh',
      );
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  throw new DshRuntimeError(DSH_NOT_FOUND);
}

function dshHome() {
  return resolve(envString('DSH_HOME') ?? join(homedir(), '.dsh'));
}

function credentialsFile() {
  return join(dshHome(), '.credentials.yaml');
}

function hasSavedAccount() {
  try {
    return /^\s{0,8}deepseek-account-platform\//m.test(readFileSync(credentialsFile(), 'utf8'));
  } catch {
    return false;
  }
}

function envFileHasDeepseekKey(file) {
  try {
    return /^[ \t]*(?:export[ \t]+)?DEEPSEEK_API_KEY[ \t]*=[ \t]*["']?[^\s"'#]+/m.test(
      readFileSync(file, 'utf8'),
    );
  } catch {
    return false;
  }
}

/**
 * Choose the DSH model route.
 *
 * - an explicit DSH_SUBAGENT_PROVIDER wins;
 * - an API key in the environment or a .env file uses deepseek-official;
 * - a signed-in desktop app is reused through deepseek-account;
 * - with no credentials, keep deepseek-official so the failure names the key.
 */
function resolveProviderSelection(cwd) {
  const model = envString('DSH_SUBAGENT_MODEL') ?? 'deepseek-flash';
  const provider = envString('DSH_SUBAGENT_PROVIDER');
  if (provider) return { provider, model };
  if (envString('DEEPSEEK_API_KEY')) return { provider: 'deepseek-official', model };
  if (envFileHasDeepseekKey(join(cwd, '.env'))) return { provider: 'deepseek-official', model };
  if (envFileHasDeepseekKey(join(dshHome(), '.env'))) return { provider: 'deepseek-official', model };
  if (envString('DSH_SUBAGENT_SAVED_AUTH') !== 'off' && hasSavedAccount()) {
    return { provider: 'deepseek-account', model };
  }
  return { provider: 'deepseek-official', model };
}

function resolveCwd(input) {
  let value = typeof input === 'string' && input.trim() !== '' ? input.trim() : process.cwd();
  if (value === '~') value = homedir();
  else if (value.startsWith('~/')) value = join(homedir(), value.slice(2));
  const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new DshRuntimeError(`Working directory does not exist: ${absolute}`);
  }
  if (!stats.isDirectory()) throw new DshRuntimeError(`Working directory is not a directory: ${absolute}`);
  return absolute;
}

function resolveMode(input) {
  const mode = input === undefined || input === null
    ? envString('DSH_SUBAGENT_PERMISSION_MODE') ?? DEFAULT_MODE
    : input;
  if (!MODES.includes(mode)) {
    throw new DshRuntimeError(`mode must be one of: ${MODES.join(', ')}`);
  }
  return mode;
}

function resolveTimeout(input, fallback) {
  const value = input === undefined || input === null ? fallback : Number(input);
  if (!Number.isFinite(value)) throw new DshRuntimeError('timeout_ms must be a number of milliseconds.');
  return Math.min(Math.max(Math.round(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function configuredWaitTimeout() {
  const value = Number(envString('DSH_SUBAGENT_WAIT_TIMEOUT_MS') ?? DEFAULT_WAIT_TIMEOUT_MS);
  return Number.isFinite(value) ? resolveTimeout(value, DEFAULT_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS;
}

function configuredMaxSessions() {
  const value = Number(envString('DSH_SUBAGENT_MAX_SESSIONS') ?? DEFAULT_MAX_SESSIONS);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 32) : DEFAULT_MAX_SESSIONS;
}

function childEnvironment(mode) {
  const environment = { ...process.env };
  for (const key of SCRUBBED_ENV) delete environment[key];
  environment.DSH_HOME = dshHome();
  environment.DSH_PERMISSION_MODE = mode;
  environment.NO_COLOR = '1';
  return environment;
}

function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// DSH session projection cache (titles, cwd, mode, resume metadata)
// ---------------------------------------------------------------------------

function isSafeSessionId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= 200
    && !id.includes('/')
    && !id.includes('\\')
    && !id.includes('\0');
}

function projectionFile(id) {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`);
}

function readProjection(id) {
  if (!isSafeSessionId(id)) return null;
  const file = projectionFile(id);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const record = parsed.record ?? {};
    const rows = record.rows ?? {};
    const identity = record.identity ?? {};
    const inbox = rows.inbox?.val ?? {};
    const queued = ['next-turn', 'next-step'].reduce(
      (total, key) => total + (Array.isArray(inbox[key]) ? inbox[key].length : 0),
      0,
    );
    return {
      id,
      title: oneLine(rows.title?.val ?? '', 120),
      cwd: identity.cwd ?? rows.workingDirectory?.val ?? null,
      mode: rows.sandboxMode?.val ?? rows.permissions?.val?.sandbox ?? null,
      permissions: rows.permissions?.val ?? null,
      createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : null,
      updatedAt: statSync(file).mtimeMs,
      queued,
      tokens: rows.tokenUsage?.val?.totals ?? null,
      file,
    };
  } catch {
    return null;
  }
}

function listProjections(limit) {
  const directory = join(dshHome(), 'storages', 'session_projcache', 'sessions');
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const file = join(directory, name);
    try {
      files.push({ file, mtime: statSync(file).mtimeMs });
    } catch {
      /* raced with a delete */
    }
  }
  files.sort((left, right) => right.mtime - left.mtime);
  const result = [];
  for (const entry of files.slice(0, Math.max(limit * 2, limit + 5))) {
    const projection = readProjection(basename(entry.file, '.json'));
    if (projection) result.push(projection);
    if (result.length >= limit) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// SDK runtime: one `dsh --profile sdk` process for one DSH session
// ---------------------------------------------------------------------------

class SdkRuntime {
  constructor({ sessionId, cwd, mode, provider, model, reasoningEffort, callbacks }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.mode = mode;
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.callbacks = callbacks;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.stdoutNoise = '';
    this.closed = false;
    this.stopping = false;
    this.ready = false;
    this.exitError = null;
  }

  async start({ resume }) {
    const dshBin = resolveDshBin();
    this.dshBin = dshBin;
    debug(`spawning ${dshBin} --profile sdk for ${this.sessionId} in ${this.cwd} (${this.mode})`);

    try {
      this.child = spawn(dshBin, ['--profile', 'sdk'], {
        cwd: this.cwd,
        env: childEnvironment(this.mode),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      throw new DshRuntimeError(`could not start ${dshBin}: ${error.message}`);
    }

    this.child.on('error', (error) => this.handleProcessFailure(error));
    this.child.on('exit', (code, signal) => this.handleExit(code, signal));
    this.child.stdin.on('error', () => {
      /* the exit handler reports the real failure */
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = appendBounded(this.stderr, String(chunk), STDERR_LIMIT);
      debug('sdk stderr:', String(chunk).trimEnd());
    });

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));

    const params = { cwd: this.cwd, provider: this.provider, model: this.model };
    if (this.reasoningEffort) params.reasoningEffort = this.reasoningEffort;

    await this.request('initialize', params, { timeoutMs: INIT_TIMEOUT_MS });
    if (resume) {
      await this.requestWithRetry('session/resume', { sessionId: this.sessionId }, { timeoutMs: INIT_TIMEOUT_MS });
    }
    this.ready = true;
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      if (!/^\[llm-/.test(trimmed)) {
        this.stdoutNoise = appendBounded(this.stdoutNoise, `${trimmed}\n`, STDERR_LIMIT);
      }
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      this.settle(message);
      return;
    }
    if (message.method === 'session.event' && message.params?.sessionId === this.sessionId) {
      this.callbacks.onEvent?.(message.params.event);
      return;
    }
    if (message.method === 'session.status' && message.params?.sessionId === this.sessionId) {
      this.callbacks.onStatus?.(message.params.status);
      return;
    }
    if (message.method === 'subagent.started' || message.method === 'subagent.finished') {
      debug(message.method, JSON.stringify(message.params).slice(0, 200));
    }
  }

  settle(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    entry.cleanup();
    if (message.error) {
      entry.reject(new DshRuntimeError(
        message.error.message ?? 'DSH request failed',
        message.error.code,
        message.error.data,
      ));
    } else {
      entry.resolve(message.result ?? {});
    }
  }

  request(method, params, options = {}) {
    const { timeoutMs, signal } = options;
    return new Promise((resolvePromise, rejectPromise) => {
      if (this.closed) {
        rejectPromise(this.exitError ?? new DshRuntimeError('DSH runtime is not running.'));
        return;
      }

      const id = `r${this.nextId++}`;
      const entry = { resolve: resolvePromise, reject: rejectPromise, cleanup: () => {} };
      const cleanup = () => {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onAbort && signal) signal.removeEventListener('abort', entry.onAbort);
      };
      entry.cleanup = cleanup;

      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          cleanup();
          rejectPromise(new DshTimeoutError(`${method} timed out after ${formatDuration(timeoutMs)}`));
        }, timeoutMs);
        entry.timer.unref?.();
      }

      if (signal) {
        if (signal.aborted) {
          cleanup();
          rejectPromise(new DshCancelledError());
          return;
        }
        entry.onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          cleanup();
          rejectPromise(new DshCancelledError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      this.pending.set(id, entry);
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        rejectPromise(error instanceof Error ? error : new DshRuntimeError(String(error)));
      }
    });
  }

  async requestWithRetry(method, params, options, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.request(method, params, options);
      } catch (error) {
        lastError = error;
        if (
          error instanceof DshRuntimeError
          && /already open|occupied|locked|in use/i.test(error.message)
          && attempt < attempts - 1
        ) {
          await sleep(800);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  async prompt(text) {
    return this.request('session/prompt', {
      sessionId: this.sessionId,
      contentBlocks: [{ type: 'text', text }],
    });
  }

  async wait(timeoutMs, signal) {
    return this.request('session/wait', { sessionId: this.sessionId }, { timeoutMs, signal });
  }

  handleProcessFailure(error) {
    if (this.closed) return;
    this.closed = true;
    this.exitError = new DshRuntimeError(`could not start DSH: ${error.message}`);
    this.rejectPending(this.exitError);
    this.callbacks.onExit?.({ error: this.exitError, stderr: this.stderr, code: null, signal: null });
  }

  handleExit(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.stopping) {
      this.rejectPending(new DshRuntimeError('DSH runtime stopped.'));
      return;
    }
    const suffix = code !== null ? ` with code ${code}` : signal ? ` (${signal})` : '';
    this.exitError = new DshRuntimeError(`DSH runtime exited${suffix}.`);
    this.rejectPending(this.exitError);
    this.callbacks.onExit?.({
      error: this.exitError,
      stderr: this.stderr,
      stdoutNoise: this.stdoutNoise,
      code,
      signal,
    });
  }

  rejectPending(error) {
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.pending.clear();
  }

  async stop({ graceful = false } = {}) {
    if (this.closed) return;
    this.stopping = true;
    if (graceful && this.ready) {
      try {
        await this.request('shutdown', {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      } catch {
        /* the process may already be gone */
      }
    }
    this.closed = true;
    this.rejectPending(new DshRuntimeError('DSH runtime stopped.'));
    if (!this.child) return;
    killTree(this.child, 'SIGTERM');
    await new Promise((resolvePromise) => {
      if (this.child.exitCode !== null) {
        resolvePromise();
        return;
      }
      const timer = setTimeout(resolvePromise, 2500);
      timer.unref?.();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    killTree(this.child, 'SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

class DshManager {
  constructor() {
    this.sessions = new Map();
    this.maxSessions = configuredMaxSessions();
  }

  get(id) {
    return this.sessions.get(id);
  }

  makeRecord({ id, cwd, mode, provider, model, persisted, title, createdAt }) {
    return {
      id,
      cwd,
      mode,
      provider,
      model,
      reasoningEffort: envString('DSH_SUBAGENT_REASONING'),
      runtime: null,
      status: 'new',
      persisted,
      assistant: [],
      seq: 0,
      turnEnd: null,
      failure: null,
      stderr: '',
      lastAnswer: '',
      title: title ?? '',
      createdAt: createdAt ?? Date.now(),
      lastActivityAt: Date.now(),
      progressToken: undefined,
      progressState: null,
      runtimeStarting: null,
    };
  }

  async create({ cwd, mode }) {
    await this.ensureCapacity();
    const selection = resolveProviderSelection(cwd);
    const record = this.makeRecord({
      id: `session-${randomUUID()}`,
      cwd,
      mode,
      provider: selection.provider,
      model: selection.model,
      persisted: false,
    });
    this.sessions.set(record.id, record);
    try {
      await this.ensureRuntime(record, false);
    } catch (error) {
      this.sessions.delete(record.id);
      throw error;
    }
    return record;
  }

  async resume(id, { cwd, mode } = {}) {
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const projection = readProjection(id);
    if (!projection) {
      throw new DshRuntimeError(
        `Unknown DSH session "${id}". Use dsh_control action:"list" to see persisted sessions, or omit session_id to start a new one.`,
      );
    }

    const storedCwd = projection.cwd ? resolve(projection.cwd) : null;
    const requestedCwd = cwd ? resolve(cwd) : null;
    if (storedCwd && requestedCwd && storedCwd !== requestedCwd) {
      throw new DshRuntimeError(
        `DSH session "${id}" was created in ${storedCwd}. Pass cwd:"${storedCwd}" to resume it.`,
      );
    }
    const targetCwd = requestedCwd ?? storedCwd ?? resolveCwd(undefined);
    if (mode && MODES.includes(projection.mode) && mode !== projection.mode) {
      throw new DshRuntimeError(
        `DSH session "${id}" uses mode ${projection.mode}. Start a new session to change the permission boundary.`,
      );
    }
    const targetMode = mode
      ?? (MODES.includes(projection.mode) ? projection.mode : DEFAULT_MODE);

    await this.ensureCapacity();
    const selection = resolveProviderSelection(targetCwd);
    const record = this.makeRecord({
      id,
      cwd: targetCwd,
      mode: targetMode,
      provider: selection.provider,
      model: selection.model,
      persisted: true,
      title: projection.title,
      createdAt: projection.createdAt,
    });
    this.sessions.set(id, record);
    try {
      await this.ensureRuntime(record, true);
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    return record;
  }

  async ensureRuntime(record, resume) {
    if (record.runtimeStarting) {
      await record.runtimeStarting;
      if (record.runtime && !record.runtime.closed) return record.runtime;
    }
    if (record.runtime && !record.runtime.closed) return record.runtime;
    record.status = 'starting';
    const runtime = new SdkRuntime({
      sessionId: record.id,
      cwd: record.cwd,
      mode: record.mode,
      provider: record.provider,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      callbacks: {
        onEvent: (event) => this.handleEvent(record, event),
        onStatus: (status) => {
          record.status = status === 'running' ? 'running' : 'idle';
          record.lastActivityAt = Date.now();
        },
        onExit: (info) => {
          if (record.runtime !== runtime) return;
          record.runtime = null;
          const noise = info.stdoutNoise ? `\n${info.stdoutNoise}` : '';
          record.stderr = `${info.stderr ?? ''}${noise}` || record.stderr;
          if (record.status !== 'stopped') {
            record.status = 'error';
            record.failure = info.error ?? new DshRuntimeError('DSH runtime exited.');
          }
        },
      },
    });
    record.runtime = runtime;
    const starting = runtime.start({ resume });
    record.runtimeStarting = starting;
    try {
      await starting;
      record.runtimeStarting = null;
    } catch (error) {
      record.runtimeStarting = null;
      await runtime.stop({ graceful: false }).catch(() => {});
      if (record.runtime === runtime) record.runtime = null;
      record.status = 'error';
      record.failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
    record.status = 'idle';
    record.lastActivityAt = Date.now();
    return runtime;
  }

  handleEvent(record, event) {
    if (!event || typeof event !== 'object') return;
    const data = event.data ?? {};
    if (typeof event.seq === 'number') record.seq = Math.max(record.seq, event.seq);
    record.lastActivityAt = Date.now();

    switch (event.type) {
      case 'assistant/message': {
        const content = Array.isArray(data.message?.content) ? data.message.content : [];
        const text = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text) {
          record.assistant.push({ seq: event.seq ?? record.seq, turn: data.turn ?? null, text });
          if (record.assistant.length > ASSISTANT_HISTORY) record.assistant.shift();
          record.lastAnswer = text;
        }
        break;
      }
      case 'turn/start':
        this.progress(record, `DSH started turn ${data.turn ?? ''}`.trim());
        break;
      case 'turn/end': {
        record.turnEnd = { seq: event.seq ?? record.seq, turn: data.turn ?? null, reason: data.reason };
        if (data.reason?.kind === 'error') {
          record.failure = data.reason.error?.message ?? 'DSH turn failed.';
        } else if (data.reason?.kind === 'aborted') {
          record.failure = 'DSH turn was aborted.';
        } else {
          record.failure = null;
        }
        break;
      }
      case 'tool/call': {
        let input = {};
        try {
          input = JSON.parse(data.arguments ?? '{}');
        } catch {
          input = {};
        }
        const detail = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.description ?? '';
        const suffix = detail ? `: ${oneLine(detail, 100)}` : '';
        this.progress(record, `DSH is using ${data.name ?? 'a tool'}${suffix}`);
        break;
      }
      default:
        break;
    }
  }

  progress(record, message) {
    if (!record.progressToken || !record.progressState) return;
    record.progressState.value += 1;
    sendMessage({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: record.progressToken,
        progress: record.progressState.value,
        message,
      },
    });
  }

  async send(record, task) {
    if (!record.runtime) await this.ensureRuntime(record, record.persisted);
    if (!record.title) record.title = oneLine(task, 100);
    const fromSeq = record.seq;
    const wasRunning = record.status === 'running';
    record.status = 'running';
    record.lastActivityAt = Date.now();
    try {
      const result = await record.runtime.prompt(task);
      record.persisted = true;
      return { fromSeq, messageId: result.messageId ?? null, wasRunning };
    } catch (error) {
      record.status = record.runtime && !record.runtime.closed ? 'idle' : 'error';
      throw error;
    }
  }

  async wait(record, fromSeq, timeoutMs, signal) {
    if (!record.runtime) await this.ensureRuntime(record, record.persisted);
    try {
      await record.runtime.wait(timeoutMs, signal);
    } catch (error) {
      if (error instanceof DshCancelledError) return { cancelled: true, sessionId: record.id };
      if (error instanceof DshTimeoutError) {
        return { status: 'running', sessionId: record.id, answer: record.lastAnswer, timeoutMs };
      }
      return {
        isError: true,
        sessionId: record.id,
        message: error instanceof Error ? error.message : String(error),
        stderr: record.stderr || record.runtime?.stderr,
      };
    }

    record.status = 'idle';
    record.lastActivityAt = Date.now();
    const turn = record.turnEnd && record.turnEnd.seq > fromSeq ? record.turnEnd : null;
    if (turn?.reason?.kind === 'error') {
      return {
        isError: true,
        sessionId: record.id,
        message: turn.reason.error?.message ?? 'DSH turn failed.',
        stderr: record.stderr,
      };
    }
    if (turn?.reason?.kind === 'aborted') {
      return { isError: true, sessionId: record.id, message: 'DSH turn was aborted.', stderr: record.stderr };
    }

    const messages = record.assistant.filter((message) => message.seq > fromSeq && message.text.trim() !== '');
    let answer = messages.length > 0 ? messages[messages.length - 1].text : '';
    if (!answer && fromSeq === 0) answer = record.lastAnswer;
    if (answer.length > ANSWER_LIMIT) {
      answer = `${answer.slice(0, ANSWER_LIMIT)}\n\n[Answer truncated by the plugin at 4 MiB.]`;
    }
    return { status: 'completed', sessionId: record.id, answer, turn };
  }

  async restart(record) {
    await this.stop(record);
    record.status = 'idle';
    await this.ensureRuntime(record, record.persisted);
  }

  async stop(record) {
    const runtime = record.runtime;
    record.status = 'stopped';
    record.runtime = null;
    if (runtime) await runtime.stop({ graceful: false });
  }

  async ensureCapacity() {
    if (this.sessions.size < this.maxSessions) return;
    const candidates = [...this.sessions.values()]
      .filter((record) => ['idle', 'stopped', 'error'].includes(record.status))
      .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
    if (candidates.length === 0) {
      throw new DshRuntimeError(
        `Too many active DSH sessions (${this.sessions.size}). Stop one with dsh_control action:"stop" and retry.`,
      );
    }
    const victim = candidates[0];
    await this.stop(victim);
    this.sessions.delete(victim.id);
    debug(`evicted idle DSH session ${victim.id}`);
  }

  list(limit) {
    const merged = new Map();
    for (const projection of listProjections(limit)) {
      merged.set(projection.id, { ...projection, loaded: false, status: 'persisted' });
    }
    for (const record of this.sessions.values()) {
      const previous = merged.get(record.id) ?? {};
      merged.set(record.id, {
        ...previous,
        id: record.id,
        title: record.title || previous.title || '',
        cwd: record.cwd,
        mode: record.mode,
        createdAt: record.createdAt,
        updatedAt: record.lastActivityAt,
        status: record.status,
        queued: previous.queued ?? 0,
        loaded: true,
      });
    }
    return [...merged.values()]
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, limit);
  }

  status(id) {
    const record = this.sessions.get(id);
    if (record) {
      return {
        loaded: true,
        id: record.id,
        status: record.status,
        cwd: record.cwd,
        mode: record.mode,
        provider: record.provider,
        model: record.model,
        createdAt: record.createdAt,
        lastActivityAt: record.lastActivityAt,
        lastAnswer: record.lastAnswer,
        failure: record.failure,
        persisted: record.persisted,
        title: record.title,
      };
    }
    const projection = readProjection(id);
    if (!projection) return null;
    return { ...projection, loaded: false, status: 'persisted' };
  }

  async shutdown() {
    const runtimes = [...this.sessions.values()]
      .map((record) => record.runtime)
      .filter((runtime) => runtime !== null);
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop({ graceful: true })));
    this.sessions.clear();
  }
}

const manager = new DshManager();

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function sessionFooter(id) {
  return `\n\n[dsh session: ${id}]`;
}

function completedText(record, outcome, { hadPrompt = true } = {}) {
  const answer = typeof outcome.answer === 'string' ? outcome.answer.trim() : '';
  if (answer) return `${outcome.answer}${sessionFooter(record.id)}`;
  if (!hadPrompt) {
    return `DSH session ${record.id} is idle. No new answer was produced in this wait. Send a task with dsh_delegate and session_id "${record.id}" to continue.${sessionFooter(record.id)}`;
  }
  return `DSH completed the task without a final text answer.${sessionFooter(record.id)}`;
}

function runningText(record, outcome) {
  const timeout = outcome.timeoutMs ? ` after ${formatDuration(outcome.timeoutMs)}` : '';
  const latest = typeof outcome.answer === 'string' && outcome.answer.trim()
    ? `\n\nLatest output:\n${truncate(outcome.answer, 2000)}`
    : '';
  return `DSH is still running in session ${record.id}${timeout}. Call dsh_wait with session_id "${record.id}" to collect the answer, or dsh_control action:"stop" to interrupt.${latest}${sessionFooter(record.id)}`;
}

function queuedText(record, sent) {
  const verb = sent.wasRunning ? 'Queued an interjection for' : 'Started';
  const note = sent.wasRunning
    ? ' DSH will process it after the current turn.'
    : '';
  return `${verb} DSH session ${record.id}.${note}\nCollect the result with dsh_wait and session_id "${record.id}".${sessionFooter(record.id)}`;
}

function formatSessionList(rows) {
  if (rows.length === 0) {
    return `No DSH sessions found in ${dshHome()}. Use dsh_delegate without session_id to start one.`;
  }
  const lines = ['DSH sessions (newest first):'];
  for (const row of rows) {
    const status = row.loaded ? row.status : 'persisted';
    const title = row.title ? oneLine(row.title, 100) : '(untitled)';
    lines.push(`- ${row.id} | ${status} | ${row.mode ?? '?'} | ${formatTime(row.updatedAt)} | ${title}`);
    if (row.cwd) lines.push(`  cwd: ${row.cwd}`);
  }
  lines.push('', 'Pass an id as session_id to dsh_delegate to continue it.');
  return lines.join('\n');
}

function formatSessionStatus(session) {
  const lines = [
    `DSH session ${session.id}`,
    `status: ${session.loaded ? session.status : 'persisted (not loaded)'}`,
  ];
  if (session.title) lines.push(`title: ${oneLine(session.title, 120)}`);
  if (session.cwd) lines.push(`cwd: ${session.cwd}`);
  if (session.mode) lines.push(`mode: ${session.mode}`);
  if (session.provider) lines.push(`provider: ${session.provider} / ${session.model}`);
  const activity = session.lastActivityAt ?? session.updatedAt;
  if (activity) lines.push(`last activity: ${formatTime(activity)}`);
  if (session.queued) lines.push(`queued messages: ${session.queued}`);
  if (session.lastAnswer) lines.push('', 'Latest answer:', truncate(session.lastAnswer, 1500));
  if (session.failure) lines.push('', `last failure: ${session.failure}`);
  return lines.join('\n');
}

function errorResult(error, record) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = record?.stderr || record?.runtime?.stderr || '';
  return {
    isError: true,
    text: failureText(message, stderr, record?.id),
    sessionId: record?.id,
  };
}

function configuredTaskTimeout() {
  const value = Number(envString('DSH_SUBAGENT_TIMEOUT_MS') ?? DEFAULT_TASK_TIMEOUT_MS);
  return Number.isFinite(value) ? resolveTimeout(value, DEFAULT_TASK_TIMEOUT_MS) : DEFAULT_TASK_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'dsh_delegate',
    title: 'Delegate to DeepSeek Harness',
    description:
      'Run a task on a DeepSeek Harness subagent and return its answer. ' +
      'Omit session_id to start a new DSH conversation; pass one to continue it — a persisted session is resumed automatically. ' +
      'Set wait:false to enqueue the task and return immediately, which is how you interject while DSH is already working; collect the outcome with dsh_wait. ' +
      'Set interrupt:true to abort the current turn (hard stop) before sending the new task. ' +
      'The subagent cannot ask questions and does not see this conversation, so include every instruction and path it needs in task. ' +
      'A successful result ends with a [dsh session: ...] footer; use it for follow-ups and do not repeat it to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          minLength: 1,
          description:
            'Complete, standalone brief: the goal, relevant absolute paths, constraints, and the exact output needed. ' +
            'The subagent sees only this text, its working directory, and its own tools. When continuing a session, this is the next user message.',
        },
        session_id: {
          type: 'string',
          description:
            'DSH session id from a previous result. Omit to start a new conversation. A persisted id is resumed automatically; ' +
            'a live idle session just receives the next turn.',
        },
        cwd: {
          type: 'string',
          description:
            'Absolute working directory for a new session. Defaults to the directory Claude Code was started in. ' +
            'When resuming, it must match the session\'s original directory; omit it to use the stored one. ' +
            'DSH may create and edit files only under this directory unless mode is danger-full-access.',
        },
        mode: {
          type: 'string',
          enum: MODES,
          description:
            'Permission boundary for a new session: `workspace-write` (default) edits files under cwd, `read-only` is for analysis, ' +
            'and `danger-full-access` removes the sandbox and approval checks. An existing session keeps the mode it was created with.',
        },
        wait: {
          type: 'boolean',
          default: true,
          description:
            'true (default) waits for DSH to become idle and returns the answer. ' +
            'false enqueues the task and returns immediately with the session id — use it for mid-run interjections, then call dsh_wait.',
        },
        interrupt: {
          type: 'boolean',
          default: false,
          description:
            'true stops the currently running turn before sending this task. The session is persisted and resumed, but the interrupted turn\'s work is discarded. ' +
            'Use it to replace a wrong direction, not for a normal follow-up.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          description:
            'Maximum time to wait for this task in milliseconds (10000–3300000). Default 900000 (15 minutes). ' +
            'On timeout the DSH run continues and the result reports that it is still running.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'dsh_wait',
    title: 'Wait for DeepSeek Harness',
    description:
      'Wait for a running DSH session to become idle and return its latest answer. ' +
      'Use it after dsh_delegate with wait:false, or when a result says DSH is still running. ' +
      'A timeout leaves the run untouched: call dsh_wait again to keep waiting, or dsh_control action:"stop" to interrupt.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'DSH session id to wait for.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          description:
            'Maximum time to wait in milliseconds (10000–3300000). Default 300000 (5 minutes). ' +
            'The DSH run is not stopped when this expires.',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'dsh_control',
    title: 'Manage DeepSeek Harness sessions',
    description:
      'Manage DSH sessions. `list` shows persisted sessions (title, cwd, mode, id) so one can be resumed. ' +
      '`status` reports whether a session is running and shows its latest output. ' +
      '`stop` interrupts a running session by stopping its runtime; the persisted session can be resumed later with dsh_delegate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'stop'],
          description: 'list persisted sessions, inspect one session, or stop a running session.',
        },
        session_id: {
          type: 'string',
          description: 'Session id for `status` and `stop`.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum sessions returned by `list`. Default 20.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleDelegate(args, context) {
  if (context.signal?.aborted) return { cancelled: true };
  const task = typeof args?.task === 'string' ? args.task : '';
  if (task.trim() === '') {
    return { isError: true, text: 'dsh_delegate requires a non-empty `task` string.' };
  }

  let cwd;
  let mode;
  try {
    if (args.cwd !== undefined && args.cwd !== null) cwd = resolveCwd(args.cwd);
    if (args.mode !== undefined && args.mode !== null) mode = resolveMode(args.mode);
  } catch (error) {
    return errorResult(error);
  }

  const wait = args.wait !== false;
  const timeoutMs = resolveTimeout(args.timeout_ms, configuredTaskTimeout());
  const sessionIdArg = typeof args.session_id === 'string' ? args.session_id.trim() : '';

  let record;
  try {
    if (sessionIdArg !== '') {
      record = manager.get(sessionIdArg);
      if (!record) {
        record = await manager.resume(sessionIdArg, { cwd, mode });
      } else {
        if (cwd && resolve(record.cwd) !== cwd) {
          return {
            isError: true,
            text: `Session ${record.id} works in ${record.cwd}. Pass that cwd, or omit cwd to use the stored directory.`,
            sessionId: record.id,
          };
        }
        if (mode && record.mode !== mode) {
          return {
            isError: true,
            text: `Session ${record.id} uses mode ${record.mode}. Start a new session to change the permission boundary.`,
            sessionId: record.id,
          };
        }
      }
      if (args.interrupt === true && record.status === 'running') {
        await manager.restart(record);
      } else if (!record.runtime) {
        await manager.ensureRuntime(record, record.persisted);
      }
    } else {
      record = await manager.create({ cwd: cwd ?? process.cwd(), mode: mode ?? resolveMode(undefined) });
    }
  } catch (error) {
    return errorResult(error, record);
  }

  if (context.signal?.aborted) return { cancelled: true, sessionId: record.id };
  record.progressToken = context.progressToken;
  record.progressState = context.progress;
  try {
    const sent = await manager.send(record, task);
    if (context.signal?.aborted) return { cancelled: true, sessionId: record.id };
    if (!wait) {
      return { text: queuedText(record, sent), sessionId: record.id };
    }
    const outcome = await manager.wait(record, sent.fromSeq, timeoutMs, context.signal);
    if (outcome.cancelled) return { cancelled: true, sessionId: record.id };
    if (outcome.isError) {
      return errorResult(new DshRuntimeError(outcome.message), { ...record, stderr: outcome.stderr });
    }
    if (outcome.status === 'running') {
      return { text: runningText(record, outcome), sessionId: record.id };
    }
    return { text: completedText(record, outcome), sessionId: record.id };
  } catch (error) {
    if (error instanceof DshCancelledError) return { cancelled: true, sessionId: record.id };
    if (error instanceof DshTimeoutError) {
      return {
        text: runningText(record, { timeoutMs, answer: record.lastAnswer }),
        sessionId: record.id,
      };
    }
    return errorResult(error, record);
  } finally {
    record.progressToken = undefined;
    record.progressState = null;
  }
}

async function handleWait(args, context) {
  const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
  if (sessionId === '') {
    return { isError: true, text: 'dsh_wait requires a non-empty `session_id` string.' };
  }
  const timeoutMs = resolveTimeout(args.timeout_ms, configuredWaitTimeout());

  let record;
  try {
    record = manager.get(sessionId) ?? await manager.resume(sessionId, {});
  } catch (error) {
    return errorResult(error);
  }

  if (context.signal?.aborted) return { cancelled: true, sessionId: record.id };
  record.progressToken = context.progressToken;
  record.progressState = context.progress;
  try {
    const outcome = await manager.wait(record, 0, timeoutMs, context.signal);
    if (outcome.cancelled) return { cancelled: true, sessionId: record.id };
    if (outcome.isError) {
      return errorResult(new DshRuntimeError(outcome.message), { ...record, stderr: outcome.stderr });
    }
    if (outcome.status === 'running') {
      return { text: runningText(record, outcome), sessionId: record.id };
    }
    return { text: completedText(record, outcome, { hadPrompt: false }), sessionId: record.id };
  } catch (error) {
    if (error instanceof DshCancelledError) return { cancelled: true, sessionId: record.id };
    if (error instanceof DshTimeoutError) {
      return {
        text: runningText(record, { timeoutMs, answer: record.lastAnswer }),
        sessionId: record.id,
      };
    }
    return errorResult(error, record);
  } finally {
    record.progressToken = undefined;
    record.progressState = null;
  }
}

async function handleControl(args) {
  const action = typeof args?.action === 'string' ? args.action : '';
  if (!['list', 'status', 'stop'].includes(action)) {
    return { isError: true, text: 'dsh_control requires action "list", "status", or "stop".' };
  }

  if (action === 'list') {
    const requested = Number(args?.limit ?? 20);
    const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 20;
    return { text: formatSessionList(manager.list(limit)) };
  }

  const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
  if (sessionId === '') {
    return { isError: true, text: `dsh_control action:"${action}" requires a non-empty session_id.` };
  }

  if (action === 'status') {
    const session = manager.status(sessionId);
    if (!session) {
      return {
        isError: true,
        text: `Unknown DSH session "${sessionId}". Use dsh_control action:"list" to see persisted sessions.`,
      };
    }
    return { text: formatSessionStatus(session) };
  }

  const record = manager.get(sessionId);
  if (!record || !record.runtime) {
    return { text: `DSH session ${sessionId} is not running.` };
  }
  await manager.stop(record);
  return {
    text: `Stopped DSH session ${sessionId}. The persisted session can be resumed with dsh_delegate and session_id "${sessionId}".`,
  };
}

// ---------------------------------------------------------------------------
// MCP protocol
// ---------------------------------------------------------------------------

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  sendMessage({ jsonrpc: '2.0', id, error });
}

const jobs = new Map();

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return replyError(message?.id ?? null, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;
  if (method === undefined) return;

  if (typeof method === 'string' && method.startsWith('notifications/')) {
    if (method === 'notifications/cancelled') {
      const target = params?.requestId;
      if (target !== undefined) jobs.get(target)?.abort();
    }
    return;
  }

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'dsh_delegate starts or continues a persistent DeepSeek Harness session. ' +
          'Use wait:false to interject while it runs, dsh_wait to collect the answer, and dsh_control to list, inspect, resume, or stop sessions.',
      });

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      if (!['dsh_delegate', 'dsh_wait', 'dsh_control'].includes(name)) {
        return replyError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      const args = params?.arguments ?? {};
      const controller = new AbortController();
      if (id !== undefined) jobs.set(id, controller);
      const progress = { value: 0 };
      const context = {
        signal: controller.signal,
        progressToken: params?._meta?.progressToken,
        progress,
      };

      try {
        let outcome;
        if (name === 'dsh_delegate') outcome = await handleDelegate(args, context);
        else if (name === 'dsh_wait') outcome = await handleWait(args, context);
        else outcome = await handleControl(args);

        if (outcome.cancelled) {
          const suffix = outcome.sessionId
            ? ` DSH session ${outcome.sessionId} is still running; use dsh_wait or dsh_control action:"status".`
            : '';
          return replyError(id, -32800, `Request cancelled.${suffix}`, outcome.sessionId ? { session_id: outcome.sessionId } : undefined);
        }

        const result = { content: [{ type: 'text', text: String(outcome.text ?? '') }] };
        if (outcome.isError) result.isError = true;
        return reply(id, result);
      } catch (error) {
        const text = failureText(
          error instanceof Error ? error.message : String(error),
          '',
          undefined,
        );
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      } finally {
        if (id !== undefined) jobs.delete(id);
      }
    }

    case 'resources/list':
      return reply(id, { resources: [] });

    case 'prompts/list':
      return reply(id, { prompts: [] });

    default:
      return replyError(id, -32601, `Method not found: ${String(method)}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of jobs.values()) controller.abort();
  const fallback = setTimeout(() => process.exit(0), 3000);
  fallback.unref?.();
  manager.shutdown()
    .catch((error) => debug('shutdown failed:', error))
    .finally(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('uncaughtException', (error) => {
  debug('uncaught exception:', error);
});
process.on('unhandledRejection', (error) => {
  debug('unhandled rejection:', error);
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  handleMessage(message).catch((error) => {
    debug('handler failed:', error);
    if (message && message.id !== undefined) {
      replyError(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
  });
});
