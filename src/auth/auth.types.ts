import type { Request } from 'express';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
}

/** The authenticated principal attached to the request by `JwtAuthGuard`. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  role: Role;
}

export type AuthedRequest = Request & { user: AuthUser };
