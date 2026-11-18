/**
 * Service-mode control channel and lifecycle wiring (LAN-3.2, Phase 1).
 *
 * The channel is opt-in: without `RHODES_SERVICE_MODE` a developer's terminal is never a
 * shutdown button. With it, only one documented command is accepted, malformed and
 * oversized input is refused without taking the process down, and repeated commands do
 * not start a second shutdown.
 *
 * The wiring test proves the ordering contract that a Windows service host depends on:
 * every signal and fault handler, and the control channel, are registered *before* the
 * `service.ready` line is written.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  MAX_CONTROL_LINE_BYTES,
  SERVICE_MODE_ENV,
  attachServiceMode,
  isServiceModeEnabled,
  wireLifecycle,
  type ControlInput,
  type LifecycleEmitter,
} from '../src/serviceMode.js';
import type { Runtime } from '../src/startup.js';
import { captureLogs } from './helpers.js';

const ENABLED = { [SERVICE_MODE_ENV]: '1' } as const;
const DISABLED = {} as const;

/** Let queued stream events run. Deterministic: no timers, no sleeps. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function occurrences(logs: string, message: string): number {
  return logs.split('\n').filter((line) => line.includes(`"msg":"${message}"`)).length;
}

function modeStdin(): PassThrough {
  return new PassThrough();
}

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    request: (reason: string) => {
      calls.push(reason);
    },
  };
}

test('service mode is enabled only by an explicit flag', () => {
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: '1' }), true);
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: 'true' }), true);
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: ' TRUE ' }), true);
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: 'yes' }), true);

  assert.equal(isServiceModeEnabled({}), false);
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: '' }), false);
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: '0' }), false);
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: 'false' }), false);
  assert.equal(isServiceModeEnabled({ [SERVICE_MODE_ENV]: 'development' }), false);
});

test('development mode keeps stdin untouched', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const logs = await captureLogs(() => {
    const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: DISABLED });
    assert.equal(controller.enabled, false);
    assert.equal(stdin.listenerCount('data'), 0, 'no listener is attached when disabled');
    assert.equal(stdin.listenerCount('end'), 0);
  });

  stdin.write('{"cmd":"shutdown"}\n');
  await flush();
  assert.deepEqual(sink.calls, [], 'typing on a developer terminal must not stop the server');
  assert.equal(logs.trim(), '', 'nothing is logged when the channel is off');
});

test('the documented shutdown command is accepted once', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const logs = await captureLogs(async () => {
    const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: ENABLED });
    assert.equal(controller.enabled, true);
    assert.equal(stdin.listenerCount('data'), 1);

    stdin.write('{"cmd":"shutdown"}\n');
    await flush();

    // A second command must not start a second shutdown sequence.
    stdin.write('{"cmd":"shutdown"}\n');
    await flush();

    controller.detach();
  });

  assert.deepEqual(sink.calls, ['stdin']);
  assert.equal(occurrences(logs, 'service.mode'), 1);
  assert.equal(occurrences(logs, 'service.control_received'), 1);
  assert.equal(occurrences(logs, 'service.stdin_ignored'), 1);
});

test('malformed JSON is refused, not acted on', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const logs = await captureLogs(async () => {
    const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: ENABLED });
    stdin.write('this is not json\n');
    await flush();
    controller.detach();
  });

  assert.deepEqual(sink.calls, []);
  assert.match(logs, /"msg":"service\.stdin_rejected".*"reason":"malformed"/);
});

test('an unknown command or an extra field is refused', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const logs = await captureLogs(async () => {
    const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: ENABLED });
    stdin.write('{"cmd":"restart"}\n');
    stdin.write('{"cmd":"shutdown","force":true}\n');
    stdin.write('{"cmd":42}\n');
    stdin.write('[]\n');
    await flush();
    controller.detach();
  });

  assert.deepEqual(sink.calls, []);
  assert.equal(occurrences(logs, 'service.stdin_rejected'), 4);
  assert.match(logs, /"reason":"unknown_command"/);
  assert.match(logs, /"reason":"malformed"/);
});

test('an oversized line is dropped and the channel stays usable', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const logs = await captureLogs(async () => {
    const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: ENABLED });

    const huge = `{"cmd":"shutdown","padding":"${'x'.repeat(MAX_CONTROL_LINE_BYTES * 2)}"}\n`;
    stdin.write(huge);
    await flush();
    assert.deepEqual(sink.calls, [], 'an oversized line is never acted on');

    // The channel recovers: a well-formed command afterwards still works.
    stdin.write('{"cmd":"shutdown"}\n');
    await flush();
    controller.detach();
  });

  assert.deepEqual(sink.calls, ['stdin']);
  assert.match(logs, /"msg":"service\.stdin_rejected".*"reason":"oversized"/);
});

test('a line that never ends is dropped instead of growing without bound', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const logs = await captureLogs(async () => {
    const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: ENABLED });
    stdin.write('x'.repeat(MAX_CONTROL_LINE_BYTES * 3));
    await flush();
    assert.deepEqual(sink.calls, []);
    stdin.write('\n{"cmd":"shutdown"}\n');
    await flush();
    controller.detach();
  });

  assert.deepEqual(sink.calls, ['stdin']);
  assert.match(logs, /"reason":"oversized"/);
});

test('an unexpected EOF shuts the process down instead of leaving an orphan', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const logs = await captureLogs(async () => {
    const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: ENABLED });
    stdin.end();
    await flush();
    controller.detach();
  });

  assert.deepEqual(sink.calls, ['stdin-eof']);
  assert.equal(occurrences(logs, 'service.stdin_eof'), 1);
});

test('detach removes every listener it added', async () => {
  const stdin = modeStdin();
  const sink = recorder();

  const controller = attachServiceMode({ stdin, requestShutdown: sink.request, env: ENABLED });
  assert.equal(stdin.listenerCount('data'), 1);
  controller.detach();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.listenerCount('error'), 0);

  stdin.write('{"cmd":"shutdown"}\n');
  await flush();
  assert.deepEqual(sink.calls, []);
});

// ── lifecycle wiring: the ordering a service host depends on ────────────────

const FAKE_RUNTIME = {
  config: {
    transport: 'https',
    host: '127.0.0.1',
    port: 4317,
    databasePath: '/tmp/rhodes/rhodes.db',
  },
  running: { port: 4317, url: 'https://127.0.0.1:4317' },
} as unknown as Pick<Runtime, 'config' | 'running'>;

test('service.ready is written after every handler has been registered', async () => {
  const order: string[] = [];
  const emitter = new EventEmitter();
  const stdin = new PassThrough();

  const instrumentedEmitter: LifecycleEmitter = {
    on(event, listener) {
      order.push(`emitter:${event}`);
      return emitter.on(event, listener);
    },
  };

  const instrumentedStdin: ControlInput = {
    on(event, listener) {
      order.push(`stdin:${event}`);
      return stdin.on(event, listener);
    },
    off(event, listener) {
      return stdin.off(event, listener);
    },
    setEncoding(encoding) {
      return stdin.setEncoding(encoding);
    },
    resume() {
      return stdin.resume();
    },
    pause() {
      return stdin.pause();
    },
  };

  const stops: Array<[string, number]> = [];
  const out = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const original = out.write;
  out.write = (chunk: unknown): boolean => {
    if (String(chunk).includes('"msg":"service.ready"')) order.push('log:service.ready');
    return true;
  };

  try {
    wireLifecycle({
      runtime: FAKE_RUNTIME,
      stdin: instrumentedStdin,
      emitter: instrumentedEmitter,
      stop: (reason, code) => stops.push([reason, code]),
      env: ENABLED,
    });
  } finally {
    out.write = original;
  }

  // Everything is registered before the announcement…
  const readyAt = order.indexOf('log:service.ready');
  assert.ok(readyAt > -1, 'service.ready must be emitted');
  for (const registration of [
    'emitter:SIGINT',
    'emitter:SIGTERM',
    'emitter:uncaughtException',
    'emitter:unhandledRejection',
    'stdin:data',
    'stdin:end',
  ]) {
    const at = order.indexOf(registration);
    assert.ok(at > -1, `${registration} must be registered`);
    assert.ok(at < readyAt, `${registration} must come before service.ready`);
  }

  // …and they all work afterwards.
  assert.equal(emitter.listenerCount('SIGINT'), 1);
  assert.equal(emitter.listenerCount('SIGTERM'), 1);
  assert.equal(emitter.listenerCount('uncaughtException'), 1);
  assert.equal(emitter.listenerCount('unhandledRejection'), 1);

  emitter.emit('SIGINT');
  await flush();
  assert.deepEqual(stops, [['SIGINT', 0]]);

  stdin.write('{"cmd":"shutdown"}\n');
  await flush();
  assert.deepEqual(stops, [
    ['SIGINT', 0],
    ['stdin', 0],
  ]);
});

test('without service mode the wiring still announces readiness and ignores stdin', async () => {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stops: Array<[string, number]> = [];

  const logs = await captureLogs(() => {
    wireLifecycle({
      runtime: FAKE_RUNTIME,
      stdin,
      emitter,
      stop: (reason, code) => stops.push([reason, code]),
      env: DISABLED,
    });
  });

  assert.equal(occurrences(logs, 'service.ready'), 1);
  assert.match(logs, /"msg":"service\.ready".*"serviceMode":false/);
  assert.equal(stdin.listenerCount('data'), 0);

  stdin.write('{"cmd":"shutdown"}\n');
  await flush();
  assert.deepEqual(stops, []);
  assert.equal(emitter.listenerCount('SIGINT'), 1, 'signal handling is independent of service mode');
});

test('the registered SIGTERM handler requests a clean shutdown with code 0', async () => {
  // Signal *delivery* is a platform matter — Windows has no POSIX signals at all — but the
  // handler's contract is ours and must hold on every platform: one registration, reason
  // `SIGTERM`, requested exit code 0. That is what a Windows service host (or a future SCM
  // integration) relies on when it asks for a graceful stop.
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stops: Array<[string, number]> = [];

  const logs = await captureLogs(() => {
    wireLifecycle({
      runtime: FAKE_RUNTIME,
      stdin,
      emitter,
      stop: (reason, code) => stops.push([reason, code]),
      env: DISABLED,
    });
  });

  assert.equal(emitter.listenerCount('SIGTERM'), 1, 'exactly one SIGTERM handler');
  emitter.emit('SIGTERM');
  await flush();

  assert.deepEqual(stops, [['SIGTERM', 0]], 'a clean stop, not a fatal one');
  assert.equal(occurrences(logs, 'service.ready'), 1);

  // A repeated signal does not start a second sequence at this layer; the process-level
  // `stop()` guard handles that, and the unit test pins only the wiring.
  emitter.emit('SIGTERM');
  await flush();
  assert.equal(stops.length, 2, 'the handler is called again; de-duplication lives in index.ts');
  assert.deepEqual(stops[1], ['SIGTERM', 0]);
});

test('an uncaught exception is logged and stops with the fatal code', async () => {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stops: Array<[string, number]> = [];

  const logs = await captureLogs(async () => {
    wireLifecycle({
      runtime: FAKE_RUNTIME,
      stdin,
      emitter,
      stop: (reason, code) => stops.push([reason, code]),
      env: DISABLED,
    });
    emitter.emit('uncaughtException', new Error('boom'));
    await flush();
  });

  assert.deepEqual(stops, [['uncaughtException', 1]]);
  assert.equal(occurrences(logs, 'service.uncaught_exception'), 1);
});
