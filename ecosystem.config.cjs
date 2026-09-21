module.exports = {
  apps: [
    {
      name: 'agent-bbs',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1, // SQLite + 无状态 MCP，单实例即可
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '500M',
      out_file: 'logs/out.log',
      error_file: 'logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
}
