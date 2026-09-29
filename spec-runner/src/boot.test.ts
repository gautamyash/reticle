import { createServer } from 'node:net';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { STATUS_PATH } from '@reticlehq/core';
import { afterEach, describe, expect, it } from 'vitest';
import { bootSession } from './boot.js';

/**
 * reticlehq/reticle#1141: `bootSession()` called `start()` with no pre-flight port check, so on a
 * machine where something already holds the port it rejected with the raw `node:net` EADDRINUSE
 * stack instead of a message anyone could act on.
 */
describe('bootSession against a port that is already taken', () => {
  let holder: ReturnType<typeof createServer> | undefined;
  // The port probe (and a raw connect from a caller that ignored the refusal) leaves its socket
  // open against this server, which is never read from and never ends it — so a plain `close()`
  // would hang the hook waiting for a connection nobody was ever going to close.
  let connections: Socket[] = [];

  afterEach(async () => {
    if (holder === undefined) return;
    connections.forEach((socket) => socket.destroy());
    connections = [];
    await new Promise<void>((resolve) => holder?.close(() => resolve()));
    holder = undefined;
  });

  it('rejects with an Error naming the port and the `port` option, not a raw EADDRINUSE', async () => {
    holder = createServer((socket) => connections.push(socket));
    const port = await new Promise<number>((resolve, reject) => {
      holder?.once('error', reject);
      holder?.listen(0, '127.0.0.1', () => {
        resolve((holder?.address() as AddressInfo).port);
      });
    });

    let caught: unknown;
    try {
      await bootSession({ driveUrl: 'http://localhost:5173', port });
      expect.unreachable('bootSession should have rejected against an already-taken port');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message, 'names the port').toContain(String(port));
    expect(message.toLowerCase(), 'names the option').toContain('port');
    expect(message, 'never a bare node error').not.toMatch(/EADDRINUSE|node:net/);
    // reticlehq/reticle#1165 review, "Stop advice misidentifies holder": a stranger process holds
    // this port, and `reticle stop` cannot touch it — only a different `port` gets bootSession going.
    expect(
      message,
      'does not send the caller after a process reticle stop cannot reach',
    ).not.toMatch(/reticle stop/);
  });
});

/**
 * reticlehq/reticle#1165 review: the maintainer's requested-changes noted the issue's own leading
 * case — a Reticle daemon already sitting on the port — had no test, unlike the generic-stranger
 * case above. A real daemon answers `STATUS_PATH`, which is what tells `probePresence` DAEMON
 * from FOREIGN; a plain TCP holder (the test above) can only ever produce FOREIGN.
 */
describe('bootSession against a port a Reticle daemon already owns', () => {
  let daemon: http.Server | undefined;

  afterEach(async () => {
    if (daemon === undefined) return;
    await new Promise<void>((resolve) => daemon?.close(() => resolve()));
    daemon = undefined;
  });

  it('rejects with an Error naming both `port` and `reticle stop`', async () => {
    daemon = http.createServer((req, res) => {
      if ('GET' === req.method && (req.url ?? '').startsWith(STATUS_PATH)) {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ running: true }));
        return;
      }
      res.writeHead(404).end();
    });
    const port = await new Promise<number>((resolve, reject) => {
      daemon?.once('error', reject);
      daemon?.listen(0, '127.0.0.1', () => {
        resolve((daemon?.address() as AddressInfo).port);
      });
    });

    let caught: unknown;
    try {
      await bootSession({ driveUrl: 'http://localhost:5173', port });
      expect.unreachable('bootSession should have rejected against a daemon-held port');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message, 'names the port').toContain(String(port));
    // Only a Reticle daemon can actually be freed by `reticle stop` — this is the one presence the
    // advice is correct for (reticlehq/reticle#1165 review, "Stop advice misidentifies holder").
    expect(message, 'offers reticle stop, the remedy that actually applies to a daemon').toMatch(
      /reticle stop/,
    );
    expect(message, 'still names the `port` option too').toMatch(/`port`/);
    // reticlehq/reticle#1165 review's exact complaint: describePresence's DAEMON fragment has no
    // trailing period, so a naive concatenation read "…serving :4400 Pass a different…" — one
    // run-on sentence with no break where the reader needs one.
    expect(message, 'closes the daemon sentence before the next one starts').toContain(
      `:${String(port)}. Pass`,
    );
  });
});
