/**
 * RHODES API · terminal prompts for local operator commands
 *
 * The only person who should ever see a password this system generates is the person
 * typing it. So:
 *
 *   · the password prompt never echoes — not the characters, not even asterisks (which
 *     would leak the length to anyone looking at the screen or a session recording);
 *   · if the terminal cannot be put into raw mode, the command STOPS. It does not fall
 *     back to a visible prompt. An operator who cannot be promised a hidden password is
 *     told to use a real console rather than being handed a silent downgrade.
 *
 * Node can read a TTY with hidden echo on Windows (`cmd.exe` and Windows Terminal) and on
 * Linux/macOS terminals, but the guarantee is only as good as the terminal. That is the
 * documented precondition for these commands.
 */

import type { Readable, Writable } from 'node:stream';

export class PromptUnavailableError extends Error {
  readonly code = 'cli.prompt_unavailable';
}

export interface PromptStreams {
  readonly input?: NodeJS.ReadStream & Readable;
  readonly output?: NodeJS.WriteStream & Writable;
}

/** Read one visible line. Used for the username only; never for a secret. */
export async function askVisible(question: string, streams: PromptStreams = {}): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  if (!input.isTTY) {
    throw new PromptUnavailableError(
      'This command needs an interactive terminal. Run it in a real console window (cmd.exe, Windows Terminal, or a Linux/macOS terminal).',
    );
  }

  output.write(question);
  return new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolve(text.slice(0, newline).replace(/\r$/, ''));
    };
    const onEnd = () => {
      cleanup();
      reject(new PromptUnavailableError('Input ended before a value was entered.'));
    };
    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.pause();
    };
    input.on('end', onEnd);
    input.on('data', onData);
    input.resume();
  });
}

/**
 * Read a secret without echoing it.
 *
 * Rejects instead of degrading: a non-TTY stdin (a pipe, a CI runner, a redirected file)
 * means the password would have to be echoed or accepted from a script, and neither is
 * acceptable for a credential. No password is ever accepted as a command-line argument.
 */
export function askSecret(question: string, streams: PromptStreams = {}): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  return new Promise<string>((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      output.write('\n');
      reject(
        new PromptUnavailableError(
          'The password prompt needs an interactive terminal so the password can be hidden. ' +
            'Run this command in a real console window instead of a pipe or a script, or use the API instead.',
        ),
      );
      return;
    }

    output.write(question);

    const previousRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.setRawMode(previousRaw ?? false);
      input.pause();
    };

    const finish = () => {
      cleanup();
      output.write('\n');
      resolve(value);
    };

    const cancel = () => {
      cleanup();
      output.write('\n');
      reject(new PromptUnavailableError('Cancelled.'));
    };

    function onData(chunk: string | Buffer): void {
      for (const char of chunk.toString()) {
        // Enter ends the entry; Ctrl-C abandons it.
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003') {
          cancel();
          return;
        }
        // Backspace and Ctrl-U edit; nothing is echoed either way.
        if (char === '\u007f' || char === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (char === '\u0015') {
          value = '';
          continue;
        }
        // Ignore control characters so escape sequences cannot enter the secret.
        if (char < ' ') continue;
        value += char;
      }
    }

    function onEnd(): void {
      cleanup();
      output.write('\n');
      reject(new PromptUnavailableError('Input ended before a password was entered.'));
    }

    input.on('data', onData);
    input.on('end', onEnd);
  });
}

/** Ask twice and compare; a typo in a hidden field is otherwise invisible. */
export async function askSecretConfirmed(question: string, streams: PromptStreams = {}): Promise<string> {
  const first = await askSecret(question, streams);
  const second = await askSecret('Repeat to confirm: ', streams);
  if (first !== second) {
    throw new PromptUnavailableError('The two entries did not match. Nothing was changed.');
  }
  return first;
}
