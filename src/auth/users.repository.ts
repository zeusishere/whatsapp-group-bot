import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { Role, User } from './auth.types.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: number;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  createdAt: r.created_at,
});

@Injectable()
export class UsersRepository {
  constructor(private readonly database: DatabaseService) {}

  count(): number {
    return (this.database.connection.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  findById(id: string): User | null {
    const row = this.database.connection.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  findByEmail(email: string): User | null {
    const row = this.database.connection.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | UserRow
      | undefined;
    return row ? toUser(row) : null;
  }

  /**
   * Inserts a user. The very first user is always promoted to admin; the check and the insert
   * run in one transaction so two concurrent bootstraps cannot both become admin.
   */
  create(input: { email: string; passwordHash: string; role: Role }): User {
    const db = this.database.connection;
    try {
      return db.transaction(() => {
        const role: Role = this.count() === 0 ? 'admin' : input.role;
        const user: User = {
          id: randomUUID(),
          email: input.email,
          passwordHash: input.passwordHash,
          role,
          createdAt: Date.now(),
        };
        db.prepare(
          `INSERT INTO users (id, email, password_hash, role, created_at)
           VALUES (@id, @email, @passwordHash, @role, @createdAt)`,
        ).run(user);
        return user;
      })();
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictException('Email already registered');
      }
      throw e;
    }
  }
}
