'use strict'

const EventEmitter = require('events');
const { fork } = require('child_process');
const { tmpdir } = require('os');
const { readFile, unlink } = require('fs');
const { promisify } = require('util');
const path = require('path');
const net = require('net');

async function getPort(nextPort = 45032) {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b });
  const server = net.createServer();
  server.listen(nextPort, function (err) {
    if (err) {
      return reject(err);
    }
    server.once('close', function () {
      resolve(nextPort)
    })
    server.close()
  });
  server.on('error', async function (err) {
    if (err.code === 'EADDRINUSE') {
      return resolve(await getPort(nextPort + 1))
    }
    return reject(err);
  });
  return promise;
}

function startFixtureProcess(t, withInspector = false, port = '0') {
  const execArgv = [ '--inspect-port', port ];
  if (withInspector) {
    execArgv.push('--inspect');
  }
  const child = fork('./test/fixtures/default-program.js', { execArgv, silent: true});
  const fixture = new FixtureProcess(child);
  fixture.on('timeout', t.fail);
  return fixture;
}

let temporaryFileCounter = 0;

function getTemporaryFile() {
  const hrtime = process.hrtime().join('');
  const random = Math.floor(Math.random() * Math.floor(Number.MAX_SAFE_INTEGER / 2));
  return path.join(tmpdir(), `${hrtime}-${temporaryFileCounter++}-${random}`);
}

function cleanupTemporaryFile(file) {
  unlink(file, (err) => {
    if (err) {
      console.error("Error while cleaning up temporary file:");
      console.error(err);
      return;
    }
  });
}

async function runObserveExecutable(command, { port, pid, toFile, options }) {
  let args = [command]
  if (pid)
    args = args.concat(['-p', pid]);
  if (port)
    args = args.concat(['-P', port]);
  if (options)
    args = args.concat(options);
  let file;
  if (toFile) {
    file = getTemporaryFile();
    args = args.concat(['-f', file]);
  }
  const child = fork('./bin/observe.js', args, { encoding: 'utf8', stdio: 'pipe' });
  let output = "";
  child.stdout.on('data', (chunk) => output = output + chunk);
  return new Promise((resolve, reject) => {
    child.on('exit', async (code, signal) => {
      if (code !== 0 || signal) {
        return reject(new Error(`Process exited with code ${code || signal}`));
      }
      if (toFile) {
        output = await promisify(readFile)(file);
        cleanupTemporaryFile(file);
      }
      if (!output) {
        return reject(new Error(`Empty output`));
      }
      return resolve(JSON.parse(output));
    });
  });
}

class FixtureProcess extends EventEmitter {
  constructor(p) {
    super();
    this._p = p;
    this.pid = p.pid;
    this._backlog = {};
    p.on('message', ({ event, payload }) => {
      payload = payload || {};
      if (this.listenerCount(event)) {
        this.emit(event, payload);
      } else {
        const events = this._backlog[event] || [];
        events.push(payload);
        this._backlog[event] = events;
      }
    });
    this.on('newListener', (event) => {
      if (this._backlog[event]) {
        for (const payload of this._backlog[event]) {
          this.emit(event, payload);
        }
        delete this._backlog[event];
      }
    });
  }

  send(event, payload = {}) {
    this._p.send({ event, payload });
  }
}

module.exports = { startFixtureProcess, FixtureProcess, runObserveExecutable, getPort }
