module.exports = async () => {
  const child = globalThis.__PG__;
  if (!child) return;
  child.stdin.end();
  await new Promise((r) => { child.on('exit', r); setTimeout(r, 8000); });
  child.kill();
};
