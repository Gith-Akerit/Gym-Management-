// For a VPS without Docker: pm2 keeps the process up and restarts it on boot.
//
//   npm ci && npm run build
//   npm run db:migrate && npm run db:seed
//   pm2 start deploy/pm2.config.cjs && pm2 save && pm2 startup
//
// Env comes from .env, which server/start.js loads itself, so secrets stay out
// of `pm2 show` and out of this file.
module.exports = {
  apps: [{
    name: 'gym',
    script: 'server/start.js',
    cwd: __dirname + '/..',
    // One process. The database is a single SQLite file and a second instance
    // would fight the first for its write lock; scale the machine, not the
    // process count.
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '400M',
    // SIGTERM is what closes the server, finishes the request in flight and
    // closes the database cleanly. Give it room before pm2 gets impatient.
    kill_timeout: 10000,
    env: { NODE_ENV: 'production' },
    error_file: 'logs/gym-error.log',
    out_file: 'logs/gym-out.log',
    time: true,
  }],
};
