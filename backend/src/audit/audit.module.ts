import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { Roles } from '../common/auth/decorators';
import { PrismaService, Tx } from '../database/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass `tx` to make the audit record atomic with the change it describes. Never put secrets/PII in `detail`. */
  record(
    entry: { actorId?: string | null; action: string; entityType: string; entityId: string; detail?: Prisma.InputJsonValue },
    tx?: Tx,
  ) {
    return (tx ?? this.prisma).auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        detail: entry.detail,
      },
    });
  }

  list(take: number, skip: number) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: { actor: { select: { email: true } } },
    });
  }
}

@Controller('admin/audit-logs')
class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN)
  list(@Query('page') page = '1') {
    const p = Math.max(1, Number(page) || 1);
    return this.audit.list(100, (p - 1) * 100);
  }
}

@Global()
@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
