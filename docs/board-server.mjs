// Serves this folder on http://localhost:4300 so board.html can load PLAN.md next to it. Browsers block that for pages
// opened from disk (file://). It also saves status and actual-hours changes made on the board into the task board table
// of PLAN.md in this folder, so run it from the main folder on main, not from a worktree: node docs/board-server.mjs
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const planFile = join(root, 'PLAN.md');
const port = Number(process.env.PORT) || 4300;
const types = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const STATUSES = ['todo', 'in progress', 'in review', 'done'];

const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const joinRow = cells => '|' + cells.map(c => (c ? ` ${c} ` : ' ')).join('|') + '|';

// Rewrites only the Status and Actual cells of one task board row; the rest of PLAN.md stays as it is.
function updateTaskRow(text, id, status, actual) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const start = lines.findIndex(l => /^\|\s*ID\s*\|\s*Task\s*\|/.test(l));
  if (start < 0) return null;
  const header = splitRow(lines[start]).map(h => h.toLowerCase());
  const statusCol = header.findIndex(h => h.startsWith('status'));
  const actualCol = header.findIndex(h => h.startsWith('actual'));
  for (let i = start + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const cells = splitRow(lines[i]);
    if (cells[0] !== id) continue;
    cells[statusCol] = status;
    cells[actualCol] = actual;
    lines[i] = joinRow(cells);
    return lines.join(eol);
  }
  return null;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1000) throw new Error('Body too large');
  }
  return JSON.parse(body);
}

// PUT /tasks/<id> with { status, actual } saves one row and returns the updated PLAN.md.
async function saveTask(req, res, id) {
  // Requiring JSON makes a cross-site page send a CORS preflight, which this server never approves; the Origin check
  // covers anything that skips it.
  const origin = req.headers.origin;
  if (!req.headers['content-type']?.startsWith('application/json') ||
      (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let input = null;
  try { input = await readJson(req); } catch { /* answered as invalid input below */ }
  const status = input?.status;
  const actual = String(input?.actual ?? '').trim();
  if (!STATUSES.includes(status) || !/^(\d+(\.\d+)?)?$/.test(actual)) {
    res.writeHead(400).end('Invalid status or actual hours');
    return;
  }
  const updated = updateTaskRow(await readFile(planFile, 'utf8'), id, status, actual);
  if (updated === null) {
    res.writeHead(404).end(`Task ${id} not found in PLAN.md`);
    return;
  }
  await writeFile(planFile, updated);
  console.log(`Task ${id}: ${status}${actual ? `, ${actual} h` : ''}`);
  res.writeHead(200, { 'Content-Type': types['.md'], 'Cache-Control': 'no-store' }).end(updated);
}

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const task = pathname.match(/^\/tasks\/(\d{2})$/);
    if (task && req.method === 'PUT') {
      await saveTask(req, res, task[1]);
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    const path = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    const file = join(root, path || 'board.html');
    // Only the board and Markdown files inside this folder are served.
    if (!file.startsWith(root) || !types[extname(file)]) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' }).end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404).end('Not found');
      return;
    }
    console.error(err);
    res.writeHead(500).end('Server error');
  }
}).listen(port, '127.0.0.1', () => console.log(`Board: http://localhost:${port}/ (saves to ${planFile})`));
