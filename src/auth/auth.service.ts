import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/env.schema.js';
import { AuthUser, JwtPayload, Role, User } from './auth.types.js';
import { hashPassword, verifyPassword } from './password.js';
import { UsersRepository } from './users.repository.js';

export interface AuthResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: AuthUser;
}

export const toAuthUser = (u: User): AuthUser => ({ id: u.id, email: u.email, role: u.role });

@Injectable()
export class AuthService {
  /** Verified against when the email is unknown, so response time doesn't reveal which emails exist. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get cfg() {
    return this.config.get('auth', { infer: true });
  }

  /** Self-service sign-up. Always open for the first user (who becomes admin), otherwise config-gated. */
  async register(email: string, password: string): Promise<AuthResult> {
    if (this.users.count() > 0 && !this.cfg.allowRegistration) {
      throw new ForbiddenException('Self-registration is disabled; ask an admin to create your account');
    }
    return this.issue(await this.createUser(email, password, 'user'));
  }

  async createUser(email: string, password: string, role: Role): Promise<User> {
    const passwordHash = await hashPassword(password);
    return this.users.create({ email: email.trim().toLowerCase(), passwordHash, role });
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = this.users.findByEmail(email.trim().toLowerCase());
    this.dummyHash ??= hashPassword('dummy-password');
    const ok = await verifyPassword(password, user ? user.passwordHash : await this.dummyHash);
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');
    return this.issue(user);
  }

  async issue(user: User): Promise<AuthResult> {
    const payload: JwtPayload = { sub: user.id, role: user.role };
    return {
      accessToken: await this.jwt.signAsync(payload),
      tokenType: 'Bearer',
      expiresIn: this.cfg.tokenTtlSeconds,
      user: toAuthUser(user),
    };
  }

  /** Validates a bearer token and returns the *current* user (so deleted users / role changes apply at once). */
  async authenticate(token: string): Promise<AuthUser> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const user = this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException('User no longer exists');
    return toAuthUser(user);
  }
}
