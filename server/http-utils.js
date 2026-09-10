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
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new HttpError(400, 'Ugyldig JSON'));
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new HttpError(400, 'Forventede et JSON-objekt'));
      resolve(parsed);
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
    if (!key) continue;
    // En fremmed cookie med et løst '%' må ikke vælte hele forespørgslen.
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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
  const decoded = safeDecode(urlPath.split('?')[0]);
  if (decoded === null) return false;
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

// X-Forwarded-For må kun bruges bag en reverse proxy man stoler på (TRUST_PROXY=1),
// ellers kan en angriber forfalske sin IP og omgå login-bremsen.
// Bag en proxy bruges den SIDSTE adresse i X-Forwarded-For (den proxyen selv har tilføjet);
// de forreste kan klienten selv skrive.
export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) {
      const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
