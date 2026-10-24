// Serves this folder on http://localhost:4300 so board.html can load PLAN.md next to it. Browsers block that for pages
// opened from disk (file://). Run from the repository root: node docs/board-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 4300;
const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)).replace(/^[/\\]+/, '');
  const file = join(root, path || 'board.html');
  // Only the board and Markdown files inside this folder are served.
  if (!file.startsWith(root) || !types[extname(file)]) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Board: http://localhost:${port}/`));
