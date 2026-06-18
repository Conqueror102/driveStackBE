import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { DriveService } from './drive/drive.service';
import { CryptoService } from './common/crypto/crypto.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const prisma = app.get(PrismaService);
  const driveService = app.get(DriveService);
  const cryptoService = app.get(CryptoService);

  const account = await prisma.connectedAccount.findFirst();
  if (!account) {
    console.log('No account found');
    await app.close();
    return;
  }

  try {
    const accessToken = cryptoService.decrypt(account.accessToken);
    const quota = await driveService.getQuota(accessToken);
    console.log('Drive Service Quota result:', quota);
    
    // Let's also do a raw call to see ALL fields returned by Google API about get
    const { google } = require('googleapis');
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });
    
    const { data } = await drive.about.get({ fields: '*' });
    console.log('Raw About response (storageQuota):', JSON.stringify(data.storageQuota, null, 2));
    
  } catch (error) {
    console.error('Error fetching quota:', error);
  } finally {
    await app.close();
  }
}

main().catch(console.error);
