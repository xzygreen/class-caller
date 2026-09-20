'use strict';

const { scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(scrypt);

/**
 * 密码摘要：scrypt + 每个密码独立盐。
 * 存储格式：scrypt$N$r$p$<salt b64url>$<hash b64url>
 * 任何地方都不得保存或记录明文密码。
 */
const N = 16384, r = 8, p = 1, KEY_LEN = 32;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  let key;
  try {
    key = await scryptAsync(password, salt, expected.length, { N: Number(n), r: Number(rr), p: Number(pp) });
  } catch {
    return false;
  }
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 管理员发起重置时生成的一次性临时密码：只在响应里出现一次 */
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

module.exports = { hashPassword, verifyPassword, temporaryPassword };
