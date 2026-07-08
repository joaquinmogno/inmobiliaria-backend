import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';

const client = new OAuth2Client();

export type VerifiedGoogleUser = {
  googleId: string;
  email: string;
};

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleUser> {
  if (!env.googleClientId) {
    throw new Error('GOOGLE_CLIENT_ID no configurado');
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.googleClientId,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error('Token de Google inválido');
  }

  if (payload.email_verified !== true) {
    throw new Error('El correo de Google no está verificado');
  }

  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
  };
}
