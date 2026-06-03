import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const displayName = process.env.ADMIN_DISPLAY_NAME || 'System Admin';

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.admin.upsert({
      where: { email },
      update: {
        passwordHash,
        displayName,
        role: 'SUPER_ADMIN',
        tokenVersion: { increment: 1 },
      },
      create: {
        email,
        passwordHash,
        displayName,
        role: 'SUPER_ADMIN',
      },
    });
    console.log(`Admin ${email} created/updated as SUPER_ADMIN`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
