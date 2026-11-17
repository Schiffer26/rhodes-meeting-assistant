/**
 * RHODES API · TLS material (phase LAN-3.1)
 *
 * LAN-3.1 gives the service an encrypted transport and nothing else: the listener is
 * still loopback-only, so no other computer can reach it. The rule about *where* the
 * socket may bind lives in `config.ts`; this module decides only *how* that socket
 * speaks. The separation is deliberate — supplying a valid certificate must never
 * become a way to widen the bind address.
 *
 *   RHODES_TLS_CERT_FILE   PEM certificate, leaf first, any chain after it
 *   RHODES_TLS_KEY_FILE    PEM private key, unencrypted in this phase
 *
 *   both present  -> HTTPS
 *   both absent   -> plain HTTP on loopback, unchanged from LAN-2.1a
 *   one present   -> refuse to start. A half-configured transport is a mistake, and there
 *                    is deliberately no fallback to HTTP: silently downgrading is how a
 *                    deployment ends up serving credentials in clear text.
 *
 * Everything here runs while configuration is loaded — before the data directory is
 * created, before the database is opened, before migrations run and before a socket
 * exists (see `startup.ts`). No function in this file returns key material to a caller
 * that logs it, and no error message embeds PEM content: an operator gets a file path
 * and a reason, never a certificate body or a private key.
 */

import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createSecureContext } from 'node:tls';

import { ConfigError } from './errors.js';

/**
 * The floor this service speaks. TLS 1.2 is the oldest version still considered sound
 * for a new deployment; TLS 1.0 and 1.1 are withdrawn (RFC 8996) and cannot be
 * negotiated with this server.
 *
 * Node's own default minimum is already TLS 1.2, but relying on that default would make
 * the guarantee depend on a runtime detail that a future Node release could change, so
 * the floor is stated here and passed to the listener explicitly.
 */
export const TLS_MIN_VERSION = 'TLSv1.2' as const;

/** Public certificate attributes. Safe to log; contains no key material. */
export interface TlsCertificateSummary {
  readonly subject: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly fingerprint256: string;
}

/** Validated TLS material, ready for `https.createServer`. */
export interface TlsMaterial {
  readonly certFile: string;
  readonly keyFile: string;
  /** PEM text. Held in memory for the listener only; never logged. */
  readonly certPem: string;
  readonly keyPem: string;
  readonly certificate: TlsCertificateSummary;
  /**
   * POSIX only: true when the private-key file is readable by group or others
   * (`mode & 0o077`). Always false on Windows, where the equivalent control is an ACL
   * that Node cannot inspect — see ARCHITECTURE.md §3.1.
   */
  readonly keyPermissionsLoose: boolean;
}

/** Raw values as they arrive from the environment. Either may be absent. */
export interface TlsFileInput {
  readonly certFile: string | undefined;
  readonly keyFile: string | undefined;
}

/**
 * Exactly what is handed to `https.createServer`.
 *
 * Deliberately minimal: no `ciphers`, no `maxVersion`, no `secureOptions`, no
 * `requestCert`. Node's defaults are kept so the service inherits secure cipher
 * selection and TLS 1.3 remains available. Pinning a cipher list here would only create
 * a second, stale copy of a policy the runtime already maintains.
 */
export interface TlsServerOptions {
  readonly cert: string;
  readonly key: string;
  readonly minVersion: typeof TLS_MIN_VERSION;
}

function reasonForCode(code: string | undefined): string {
  switch (code) {
    case 'ENOENT':
      return 'the file does not exist';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'the path is a directory, not a file';
    default:
      return code ? `the operating system reported ${code}` : 'the read failed';
  }
}

function readPemFile(file: string, kind: 'cert' | 'key'): string {
  const code = kind === 'cert' ? 'config.tls_cert_unreadable' : 'config.tls_key_unreadable';
  const variable = kind === 'cert' ? 'RHODES_TLS_CERT_FILE' : 'RHODES_TLS_KEY_FILE';

  let pem: string;
  try {
    pem = readFileSync(file, 'utf8');
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(code, `${variable} could not be read: ${reasonForCode(errno)}.`, {
      file,
      code: errno ?? null,
    });
  }

  if (pem.trim() === '') {
    throw new ConfigError(code, `${variable} points at an empty file, which is not PEM material.`, {
      file,
    });
  }

  return pem;
}

function summarise(certificate: X509Certificate): TlsCertificateSummary {
  return {
    subject: certificate.subject.replace(/\r?\n/g, ', '),
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    fingerprint256: certificate.fingerprint256,
  };
}

/** Group/other permission bits on the key file. Windows ACLs are not visible here. */
function keyPermissionsLoose(file: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    return (statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/**
 * Validate the two optional file paths and load the material they name.
 *
 * Returns `null` when neither variable is set, which is the LAN-2.1a behaviour: plain
 * HTTP on loopback. Every failure throws a `ConfigError`, so startup stops before the
 * data directory is created, before the database is opened and before anything listens.
 *
 * Fail-closed checks, in order: both-or-neither, file readable and non-empty, certificate
 * parses as X.509, key parses as an unencrypted private key, the key belongs to the
 * certificate, and finally OpenSSL accepts the pair as a usable secure context (which
 * also covers a chain the runtime cannot build).
 */
export function loadTlsMaterial(input: TlsFileInput): TlsMaterial | null {
  const certFile = input.certFile?.trim();
  const keyFile = input.keyFile?.trim();

  if (!certFile && !keyFile) return null;

  if (!certFile || !keyFile) {
    const missing = certFile ? 'RHODES_TLS_KEY_FILE' : 'RHODES_TLS_CERT_FILE';
    throw new ConfigError(
      'config.tls_incomplete',
      'TLS needs both a certificate and a private key. ' +
        `${missing} is missing, so the transport is half-configured and is refused rather than ` +
        'silently downgraded to HTTP. Set both RHODES_TLS_CERT_FILE and RHODES_TLS_KEY_FILE, ' +
        'or neither for loopback HTTP.',
    );
  }

  const certPath = path.resolve(certFile);
  const keyPath = path.resolve(keyFile);

  const certPem = readPemFile(certPath, 'cert');
  const keyPem = readPemFile(keyPath, 'key');

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certPem);
  } catch (error) {
    throw new ConfigError(
      'config.tls_cert_invalid',
      'RHODES_TLS_CERT_FILE does not contain a PEM-encoded X.509 certificate.',
      { file: certPath, reason: error instanceof Error ? error.message : String(error) },
    );
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(keyPem);
  } catch (error) {
    throw new ConfigError(
      'config.tls_key_invalid',
      'RHODES_TLS_KEY_FILE does not contain an unencrypted PEM private key. ' +
        'Passphrase-protected keys are not supported in this phase.',
      { file: keyPath, reason: error instanceof Error ? error.message : String(error) },
    );
  }

  let matches = false;
  try {
    matches = certificate.checkPrivateKey(privateKey);
  } catch {
    // A key type the runtime cannot compare is treated as a mismatch: fail closed.
    matches = false;
  }

  if (!matches) {
    throw new ConfigError(
      'config.tls_pair_mismatch',
      'The certificate in RHODES_TLS_CERT_FILE was not issued for the private key in ' +
        'RHODES_TLS_KEY_FILE. Refusing to start.',
      { certFile: certPath, keyFile: keyPath },
    );
  }

  try {
    // Last gate: let the TLS implementation build the context it will actually use. This
    // catches anything the two checks above accept but the handshake could not use, such
    // as a chain the runtime cannot load.
    createSecureContext({ cert: certPem, key: keyPem });
  } catch (error) {
    throw new ConfigError(
      'config.tls_pair_rejected',
      'The certificate and private key were readable but the TLS implementation refused the ' +
        'pair. Refusing to start.',
      {
        certFile: certPath,
        keyFile: keyPath,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return Object.freeze({
    certFile: certPath,
    keyFile: keyPath,
    certPem,
    keyPem,
    certificate: Object.freeze(summarise(certificate)),
    keyPermissionsLoose: keyPermissionsLoose(keyPath),
  });
}

/**
 * The options object for `https.createServer`, derived from validated material.
 *
 * One place decides the protocol floor; `server.ts` does not add TLS settings of its own.
 */
export function tlsServerOptions(material: TlsMaterial): TlsServerOptions {
  return {
    cert: material.certPem,
    key: material.keyPem,
    minVersion: TLS_MIN_VERSION,
  };
}
