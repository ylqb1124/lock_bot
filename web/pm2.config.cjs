module.exports = {
  apps: [{
    name: 'xpu-monitor',
    script: 'server/proxy.cjs',
    cwd: __dirname,
    interpreter: 'node',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
