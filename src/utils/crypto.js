import { createHash, randomBytes } from 'node:crypto';

export function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function randomToken(size = 32) {
  return base64UrlEncode(randomBytes(size));
}

export function sha256Base64Url(input) {
  return base64UrlEncode(createHash('sha256').update(input).digest());
}

export function nowMs() {
  return Date.now();
}