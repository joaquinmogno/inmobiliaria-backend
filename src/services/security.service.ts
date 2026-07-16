import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { env } from '../config/env';

export const SESSION_COOKIE = 'pc_session';
export const CSRF_COOKIE = 'pc_csrf';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const privilegedRoles = new Set(['SUPERADMIN', 'OWNER', 'JEFE', 'ADMIN']);

export function sha256(value: string) {
  return crypto.createHmac('sha256', env.sessionSecret).update(value).digest('hex');
}

export function createSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function getClientIp(req: Request) {
  return req.ip || req.socket.remoteAddress || null;
}

export function getUserAgent(req: Request) {
  return req.get('user-agent')?.slice(0, 500) || null;
}

export function getCookieOptions(httpOnly: boolean) {
  const secure = env.nodeEnv === 'production';
  return {
    httpOnly,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_MS
  };
}

export function clearAuthCookies(res: Response) {
  const secure = env.nodeEnv === 'production';
  res.clearCookie(SESSION_COOKIE, { path: '/', secure, sameSite: 'lax' });
  res.clearCookie(CSRF_COOKIE, { path: '/', secure, sameSite: 'lax' });
}

export async function createSession(params: {
  userId: number;
  inmobiliariaId: number;
  sessionVersion: number;
  req: Request;
  res: Response;
}) {
  const sessionToken = createSecureToken(48);
  const csrfToken = createSecureToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.userSession.create({
    data: {
      tokenHash: sha256(sessionToken),
      csrfTokenHash: sha256(csrfToken),
      usuarioId: params.userId,
      inmobiliariaId: params.inmobiliariaId,
      sessionVersion: params.sessionVersion,
      expiresAt,
      ipAddress: getClientIp(params.req) || undefined,
      userAgent: getUserAgent(params.req) || undefined
    }
  });

  params.res.cookie(SESSION_COOKIE, sessionToken, getCookieOptions(true));
  params.res.cookie(CSRF_COOKIE, csrfToken, getCookieOptions(false));

  return { csrfToken, expiresAt };
}

export async function revokeSession(sessionId: number) {
  await prisma.userSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export async function revokeAllUserSessions(userId: number) {
  await prisma.userSession.updateMany({
    where: { usuarioId: userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export function validatePasswordStrength(password: string, userHints: string[] = []) {
  const errors: string[] = [];
  if (password.length < 12) errors.push('La contraseña debe tener al menos 12 caracteres');
  if (password.length > 128) errors.push('La contraseña no puede superar 128 caracteres');
  if (!/[a-z]/.test(password)) errors.push('Debe incluir una letra minúscula');
  if (!/[A-Z]/.test(password)) errors.push('Debe incluir una letra mayúscula');
  if (!/[0-9]/.test(password)) errors.push('Debe incluir un número');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Debe incluir un símbolo');

  const normalized = password.toLowerCase();
  for (const hint of userHints.filter(Boolean)) {
    const cleanHint = hint.toLowerCase().trim();
    if (cleanHint.length >= 4 && normalized.includes(cleanHint)) {
      errors.push('La contraseña no debe contener datos del usuario');
      break;
    }
  }

  return errors;
}

function getBackupKey() {
  return crypto.createHash('sha256').update(env.backupEncryptionKey).digest();
}

export async function encryptFile(sourcePath: string, destinationPath: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getBackupKey(), iv);
  const handle = await fs.open(destinationPath, 'w', 0o600);

  try {
    await handle.write(Buffer.concat([Buffer.from('PCBK1'), iv, Buffer.alloc(16)]), 0, 33, 0);
    await pipeline(
      createReadStream(sourcePath),
      cipher,
      createWriteStream(destinationPath, { fd: handle.fd, start: 33, autoClose: false })
    );
    await handle.write(cipher.getAuthTag(), 0, 16, 17);
  } finally {
    await handle.close();
  }
}

export async function decryptFileToFile(encryptedPath: string, destinationPath: string) {
  const handle = await fs.open(encryptedPath, 'r');
  const header = Buffer.alloc(33);

  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error('Formato de backup cifrado inválido');
  } finally {
    await handle.close();
  }

  const magic = header.subarray(0, 5).toString();
  if (magic !== 'PCBK1') throw new Error('Formato de backup cifrado inválido');
  const iv = header.subarray(5, 17);
  const authTag = header.subarray(17, 33);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getBackupKey(), iv);
  decipher.setAuthTag(authTag);

  try {
    await pipeline(
      createReadStream(encryptedPath, { start: 33 }),
      decipher,
      createWriteStream(destinationPath, { mode: 0o600 })
    );
  } catch (error) {
    await fs.unlink(destinationPath).catch(() => undefined);
    throw error;
  }
}
