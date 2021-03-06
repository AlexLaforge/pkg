import { spawn } from 'child_process';

const script = `
  var vm = require('vm');
  var module = require('module');
  var stdin = new Buffer(0);
  process.stdin.on('data', function (data) {
    stdin = Buffer.concat([ stdin, data ]);
    if (stdin.length >= 4) {
      var sizeOfSnap = stdin.readInt32LE(0);
      if (stdin.length >= 4 + sizeOfSnap + 4) {
        var sizeOfBody = stdin.readInt32LE(4 + sizeOfSnap);
        if (stdin.length >= 4 + sizeOfSnap + 4 + sizeOfBody) {
          var snap = stdin.toString('utf8', 4, 4 + sizeOfSnap);
          var body = new Buffer(sizeOfBody);
          var startOfBody = 4 + sizeOfSnap + 4;
          stdin.copy(body, 0, startOfBody, startOfBody + sizeOfBody);
          stdin = new Buffer(0);
          var code = module.wrap(body);
          var s = new vm.Script(code, {
            filename: snap,
            produceCachedData: true,
            sourceless: true
          });
          if (!s.cachedDataProduced) {
            console.error('Pkg: Cached data not produced.');
            process.exit(2);
          }
          var h = new Buffer(4);
          var b = s.cachedData;
          h.writeInt32LE(b.length, 0);
          process.stdout.write(h);
          process.stdout.write(b);
        }
      }
    }
  });
  process.stdin.resume();
`;

const children = {};

export function fabricate (options, fabricator, snap, body, cb) {
  const cmd = fabricator.binaryPath;
  const key = JSON.stringify([ cmd, options ]);
  let child = children[key];

  if (!child) {
    child = children[key] = spawn(
      cmd, [ '--pkg-fallback' ].concat(options).concat('-e', script),
      { stdio: [ 'pipe', 'pipe', 'inherit' ] }
    );
  }

  let stdout = Buffer.alloc(0);

  function onError (error) {
    removeListeners();
    cb(new Error(`Was not able to make bytecode for '${JSON.stringify(fabricator)}' (${error.message})`));
  }

  function onClose (code) {
    removeListeners();
    if (code !== 0) {
      return cb(new Error(`Was not able to make bytecode for '${JSON.stringify(fabricator)}'`));
    } else {
      return cb(new Error(`${cmd} closed unexpectedly`));
    }
  }

  function onData (data) {
    stdout = Buffer.concat([ stdout, data ]);
    if (stdout.length >= 4) {
      const sizeOfBlob = stdout.readInt32LE(0);
      if (stdout.length >= 4 + sizeOfBlob) {
        const blob = Buffer.alloc(sizeOfBlob);
        stdout.copy(blob, 0, 4, 4 + sizeOfBlob);
        removeListeners();

        if (fabricator.nodeRange === 'node0') {
          // node0 can not produce second time.
          // probably because of 'filename' cache
          delete children[key];
          child.kill();
        }

        return cb(undefined, blob);
      }
    }
  }

  child.on('error', onError);
  child.on('close', onClose);
  child.stdin.on('error', onError);
  child.stdout.on('error', onError);
  child.stdout.on('data', onData);
  function removeListeners () {
    child.removeListener('error', onError);
    child.removeListener('close', onClose);
    child.stdin.removeListener('error', onError);
    child.stdout.removeListener('error', onError);
    child.stdout.removeListener('data', onData);
  }

  const h = Buffer.alloc(4);
  let b = Buffer.from(snap);
  h.writeInt32LE(b.length, 0);
  child.stdin.write(h);
  child.stdin.write(b);
  b = body;
  h.writeInt32LE(b.length, 0);
  child.stdin.write(h);
  child.stdin.write(b);
}

export function shutdown () {
  for (const key in children) {
    const child = children[key];
    child.kill();
  }
}
