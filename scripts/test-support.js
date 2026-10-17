// Shared by the tests that start a demo server or a fake session host: what keeps them apart from each other and from
// the live Fleet View, on Windows and macOS alike. Not a test itself (the gate runs *-test.js files only).
//   freePort()       a Promise of a port nothing listens on now (the system picks it), so two test gates at once never
//                    start two demo servers on one port, or judge the other worktree's server (#526)
//   dataDirIn(home)  Fleet View's data folder for a server started with LOCALAPPDATA, HOME and XDG_STATE_HOME at home:
//                    <home>\fleet-view on Windows, <home>/Library/Application Support/fleet-view on macOS, <home>/fleet-view
//                    elsewhere (platform.js dataDir; the api-token is in it, #585)
//   testPipe(name)   a session-host test pipe: \\.\pipe\fleet-view-host-<name> on Windows, else the socket
//                    <temp>/fleet-view-host-<name>.sock. Not under a mkdtemp folder: on macOS that path passes the
//                    100 bytes host.js takes for a test pipe, and host.js then talks to the real host's socket. Throws
//                    rather than hand back one that long.
'use strict';
const net = require('net');
const os = require('os');
const path = require('path');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function dataDirIn(home) {
  if (process.platform === 'win32') return path.join(home, 'fleet-view');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'fleet-view');
  return path.join(home, 'fleet-view');
}

function testPipe(name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\fleet-view-host-${name}`;
  const p = path.join(os.tmpdir(), `fleet-view-host-${name}.sock`);
  if (Buffer.byteLength(p) > 100) throw new Error(`the test pipe ${p} is over 100 bytes: host.js would use the real host's`);
  return p;
}

module.exports = { freePort, dataDirIn, testPipe };
