/**
 * PM2 keeps the API running and restarts it on crash or reboot.
 *
 *   pm2 start deploy/ecosystem.config.cjs && pm2 save
 *
 * Exactly one process. The daily queue counter is safe under more (it is a row
 * lock), but the login/PIN guessing limits are counted in memory and would be
 * multiplied by the number of processes.
 */
module.exports = {
  apps: [
    {
      name: 'vista-api',
      cwd: '/opt/vista/api',
      script: 'src/server.ts',
      interpreter: 'node',
      // Node 24 runs the TypeScript sources directly; there is no build step.
      interpreter_args: '--experimental-strip-types',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
