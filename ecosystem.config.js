module.exports = {
  apps: [{
    name: 'kanban',
    script: 'server/index.js',
    cwd: '/home/xiko/kanban-app',
    env: {
      NODE_ENV: 'production',
      PORT: 3400,
      KANBAN_PATH: '/home/xiko/clawd/kanban.md',
      KANBAN_TOKEN: '3406827caafc6a7eb3abbceefb872d905846fbba9155e79c'
    }
  }]
};
