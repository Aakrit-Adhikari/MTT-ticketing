const { spawn } = require('child_process');
const path = require('path');

module.exports = async () => {
  if (process.env.TEST_DATABASE_URL) return; // use an externally provided database (e.g. CI service container)
  const child = spawn(process.execPath, [path.join(__dirname, 'pg-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  globalThis.__PG__ = child;
  process.env.TEST_DATABASE_URL = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/READY (\S+)/);
      if (m) resolve(m[1]);
    });
    child.on('exit', (c) => reject(new Error(`test postgres exited early (${c})`)));
  });
};
