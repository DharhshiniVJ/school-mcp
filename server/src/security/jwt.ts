import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getConfig } from '../config/env.js';
import { JWTPayload } from '../types/index.js';

/**
 * Hashes a plaintext password using bcryptjs
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Compares a plaintext password with a hashed password
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Signs a JWT token containing user role and identity
 */
export function signToken(payload: JWTPayload): string {
  const config = getConfig();
  const { secret, expiresIn } = config.jwt;
  
  // Use jsonwebtoken to sign the payload
  return jwt.sign(payload, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

/**
 * Verifies a JWT token and returns the payload if valid, otherwise throws an error
 */
export function verifyToken(token: string): JWTPayload {
  const config = getConfig();
  const { secret } = config.jwt;
  
  try {
    const decoded = jwt.verify(token, secret);
    return decoded as JWTPayload;
  } catch (error) {
    throw new Error('Invalid or expired authentication token');
  }
}
