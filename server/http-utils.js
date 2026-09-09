// Små hjælpere til node:http: JSON-svar, body-parsing, cookies, statiske filer.

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_BODY_BYTES = 512 * 1024;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Forespørgslen er for stor'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Ugyldig JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function cookieHeader(name, value, { maxAgeSeconds, secure = false, path: cookiePath = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, 'HttpOnly', 'SameSite=Lax'];
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// Serverer en fil fra `root`. Returnerer false hvis filen ikke findes.
export async function serveStatic(res, root, urlPath, { cacheControl = 'no-cache' } = {}) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(root, safe);
  if (!filePath.startsWith(root)) return false;
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  createReadStream(filePath).pipe(res);
  return true;
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
