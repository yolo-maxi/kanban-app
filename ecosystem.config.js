module.exports = {
  apps: [{
    name: 'kanban',
    script: 'server/index.js',
    cwd: '/home/xiko/kanban-app',
    env: {
      NODE_ENV: process.env.NODE_ENV || 'production',
      PORT: process.env.PORT || 3400,
      KANBAN_PATH: process.env.KANBAN_PATH || '/home/xiko/clawd/kanban.md',
      KANBAN_TOKEN: process.env.KANBAN_TOKEN,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      CORS_ORIGINS: process.env.CORS_ORIGINS || 'https://kanban.repo.box',
      ALLOW_QUERY_TOKEN_AUTH: process.env.ALLOW_QUERY_TOKEN_AUTH || 'false'
    }
  }]
};
