import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.connectedAccount.findMany();
  console.log(accounts.map((a: any) => ({
    email: a.googleEmail,
    limit: a.storageLimit,
    used: a.storageUsed,
    updatedAt: a.quotaUpdatedAt,
    status: a.status
  })));
}

main().catch(console.error).finally(() => prisma.$disconnect());
