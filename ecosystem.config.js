// PM2 設定。node_args 用 --env-file 讀 .env：
// 這樣 JWT_SECRET 與管理員密碼不會出現在 pm2 的程序清單或環境變數傾印裡。
module.exports = {
  apps: [{
    name: 'relaxcare',
    script: 'src/server.js',
    cwd: '/root/relaxcare',
    exec_mode: 'fork',
    instances: 1,
    node_args: '--env-file=.env',
    autorestart: true,
    max_memory_restart: '400M',
    time: true
  }]
};
