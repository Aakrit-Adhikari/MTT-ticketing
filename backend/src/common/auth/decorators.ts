import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Role } from '@prisma/client';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';

/** Explicitly opt out of authentication (public customer endpoints, login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/**
 * Every non-public handler MUST declare roles; handlers without it are denied (default-deny).
 * SUPER_ADMIN always passes.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
