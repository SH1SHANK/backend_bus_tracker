import { randomBytes, scrypt, timingSafeEqual, type BinaryLike } from 'node:crypto';

const KEYLEN = 32;
const scryptAsync = (pw: BinaryLike, salt: BinaryLike, len: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(pw, salt, len, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** Format: scrypt$<salt b64>$<hash b64> */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const actual = await scryptAsync(secret, Buffer.from(s, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}
