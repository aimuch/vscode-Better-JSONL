// Static file server for the webview harness. Serves the project root.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'text/plain', '.map': 'application/json' };

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (rel === 'favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (rel.startsWith('..')) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(join(root, rel || 'test/web/harness.html'));
      res.writeHead(200, { 'content-type': types[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 5177);
  const server = await startServer(port);
  console.log(`harness: http://127.0.0.1:${server.address().port}/test/web/harness.html?file=events.jsonl`);
}
