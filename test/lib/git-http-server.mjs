import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

/**
 * A smart-HTTP git remote that behaves like GitHub on the one axis the autofix
 * push tests care about: WHO is pushing. Test utility.
 *
 * Reads: every request's Authorization header.
 * Writes: the pushed refs, through the real `git http-backend` over a bare
 *         repository under `projectRoot`.
 * Does NOT: authenticate anyone. A request with no Authorization is challenged
 *           with a 401 (so git falls back to credentials in the URL, as it would
 *           against GitHub), a credential listed in `refuse` gets a 403, and
 *           everything else is served.
 *
 * `seen` records every request, so a test can say which token reached the
 * `git-receive-pack` POST: the push GitHub would attribute.
 */
export async function startGitServer(projectRoot, { refuse = [] } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    const record = { method: req.method, url: req.url, auth, status: 200 };
    seen.push(record);
    if (!auth) {
      record.status = 401;
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
      res.end();
      return;
    }
    if (refuse.some((r) => tokenOf(r) === tokenOf(auth))) {
      record.status = 403;
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Permission denied');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      // http-backend serves receive-pack only to an authenticated user.
      REMOTE_USER: 'x-access-token',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
    const cgi = spawn('git', ['http-backend'], { env });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    cgi.stdout.on('data', (chunk) => {
      if (started) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10);
        else headers[key] = value;
      }
      record.status = status;
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
      started = true;
    });
    cgi.on('close', () => {
      if (!started) { record.status = 500; res.writeHead(500); }
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The token inside a `basic base64(x-access-token:TOKEN)` header, or null. */
export function tokenOf(authorization) {
  const m = /^basic\s+(\S+)$/i.exec(authorization ?? '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** The header git sends for a token, spelled the way actions/checkout spells it. */
export function basicFor(token) {
  return `basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}
