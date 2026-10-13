#!/usr/bin/env node
// Development: the API server (restarts on change) and the Vite dev server
// (hot reload, proxies /api to the server). Open http://127.0.0.1:5420.
import { spawn } from 'node:child_process';

const env = { ...process.env, AGENT_STUDIO_ENV: 'development', AGENT_STUDIO_WEB_DIR: '' };
const children = [
  spawn('npm', ['run', 'dev', '-w', '@agent-studio/server'], { stdio: 'inherit', env }),
  spawn('npm', ['run', 'dev', '-w', '@agent-studio/web'], { stdio: 'inherit', env }),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => (stop(), process.exit(code ?? 0)));
