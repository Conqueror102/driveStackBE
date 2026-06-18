import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { google, drive_v3 } from 'googleapis';

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  webContentLink?: string;
  thumbnailLink?: string;
  iconLink?: string;
  exportLinks?: Record<string, string>;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
};

export type DriveThumbnailMetadata = Pick<
  DriveFile,
  'id' | 'name' | 'mimeType' | 'thumbnailLink' | 'iconLink' | 'modifiedTime'
>;

export type DriveChange = {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
};

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  async listFiles(
    accessToken: string,
    options: { pageToken?: string; pageSize?: number; query?: string } = {},
  ): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    try {
      const drive = this.client(accessToken);
      const { data } = await drive.files.list({
        pageToken: options.pageToken,
        pageSize: Math.min(options.pageSize || 100, 1000),
        q: options.query || 'trashed=false',
        fields:
          'nextPageToken, files(id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,iconLink,exportLinks,parents,createdTime,modifiedTime)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return {
        files: (data.files || []).map((file) => this.normalizeFile(file)),
        nextPageToken: data.nextPageToken || undefined,
      };
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async listFolderChildren(
    accessToken: string,
    folderId: string,
    options: { pageToken?: string; pageSize?: number } = {},
  ): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    return this.listFiles(accessToken, {
      pageToken: options.pageToken,
      pageSize: options.pageSize || 1000,
      query: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
    });
  }

  async getQuota(accessToken: string): Promise<{ limit: bigint; usage: bigint; usageInDrive: bigint }> {
    try {
      const drive = this.client(accessToken);
      const { data } = await drive.about.get({ fields: 'storageQuota' });
      return {
        limit: BigInt(data.storageQuota?.limit || '0'),
        usage: BigInt(data.storageQuota?.usage || '0'),
        usageInDrive: BigInt(data.storageQuota?.usageInDrive || '0'),
      };
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async getStartPageToken(accessToken: string): Promise<string> {
    try {
      const { data } = await this.client(accessToken).changes.getStartPageToken();
      return data.startPageToken || '';
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async listChanges(
    accessToken: string,
    pageToken: string,
    options: { pageSize?: number } = {},
  ): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }> {
    try {
      const { data } = await this.client(accessToken).changes.list({
        pageToken,
        pageSize: Math.min(options.pageSize || 1000, 1000),
        spaces: 'drive',
        fields:
          'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,iconLink,exportLinks,parents,createdTime,modifiedTime))',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return {
        changes: (data.changes || []).map((change) => ({
          fileId: change.fileId || '',
          removed: Boolean(change.removed),
          file: change.file ? this.normalizeFile(change.file) : undefined,
        })),
        nextPageToken: data.nextPageToken || undefined,
        newStartPageToken: data.newStartPageToken || undefined,
      };
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async createResumableUploadSession(
    accessToken: string,
    metadata: { name: string; mimeType: string; fileSize?: number; parentId?: string; origin: string },
  ): Promise<string> {
    try {
      const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': metadata.mimeType,
          ...(metadata.fileSize ? { 'X-Upload-Content-Length': String(metadata.fileSize) } : {}),
          Origin: metadata.origin,
        },
        body: JSON.stringify({
          name: metadata.name,
          mimeType: metadata.mimeType,
          ...(metadata.parentId ? { parents: [metadata.parentId] } : {}),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new HttpException(`Failed to create Drive upload session: ${response.status} ${errorText}`, response.status);
      }

      const location = response.headers.get('Location');
      if (!location) {
        throw new ServiceUnavailableException('Drive did not return an upload session URI');
      }
      return location;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.handleGoogleError(error);
    }
  }

  async deleteFile(accessToken: string, fileId: string): Promise<void> {
    try {
      await this.client(accessToken).files.delete({ fileId });
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async trashFile(accessToken: string, fileId: string): Promise<void> {
    try {
      await this.client(accessToken).files.update({
        fileId,
        requestBody: { trashed: true },
        supportsAllDrives: true,
      });
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async restoreFile(accessToken: string, fileId: string): Promise<void> {
    try {
      await this.client(accessToken).files.update({
        fileId,
        requestBody: { trashed: false },
        supportsAllDrives: true,
      });
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async createFolder(accessToken: string, metadata: { name: string; parentId?: string }): Promise<DriveFile> {
    try {
      const { data } = await this.client(accessToken).files.create({
        requestBody: {
          name: metadata.name,
          mimeType: 'application/vnd.google-apps.folder',
          ...(metadata.parentId ? { parents: [metadata.parentId] } : {}),
        },
        fields: 'id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,iconLink,exportLinks,parents,createdTime,modifiedTime',
        supportsAllDrives: true,
      });
      return this.normalizeFile(data);
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async copyFile(accessToken: string, fileId: string, metadata: { name?: string; parentId?: string } = {}): Promise<DriveFile> {
    try {
      const { data } = await this.client(accessToken).files.copy({
        fileId,
        requestBody: {
          ...(metadata.name ? { name: metadata.name } : {}),
          ...(metadata.parentId ? { parents: [metadata.parentId] } : {}),
        },
        fields: 'id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,iconLink,exportLinks,parents,createdTime,modifiedTime',
        supportsAllDrives: true,
      });
      return this.normalizeFile(data);
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async grantReaderPermission(accessToken: string, fileId: string, emailAddress: string): Promise<string | null> {
    try {
      const { data } = await this.client(accessToken).permissions.create({
        fileId,
        sendNotificationEmail: false,
        requestBody: {
          type: 'user',
          role: 'reader',
          emailAddress,
        },
        fields: 'id',
        supportsAllDrives: true,
      });
      return data.id || null;
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async revokePermission(accessToken: string, fileId: string, permissionId: string): Promise<void> {
    try {
      await this.client(accessToken).permissions.delete({
        fileId,
        permissionId,
        supportsAllDrives: true,
      });
    } catch (error) {
      this.logger.warn(`Failed to revoke Drive permission ${permissionId} on ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadFile(accessToken: string, fileId: string): Promise<Response> {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) throw new UnauthorizedException('Drive token is invalid');
    if (response.status === 403) throw new ForbiddenException('Drive access forbidden');
    if (response.status === 404) throw new NotFoundException('Drive file not found');
    if (!response.ok) throw new ServiceUnavailableException('Google Drive media unavailable');
    return response;
  }

  async getFile(accessToken: string, fileId: string): Promise<DriveFile> {
    try {
      const { data } = await this.client(accessToken).files.get({
        fileId,
        fields: 'id,name,mimeType,size,webViewLink,webContentLink,thumbnailLink,iconLink,exportLinks,parents,createdTime,modifiedTime',
        supportsAllDrives: true,
      });
      return this.normalizeFile(data);
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async getThumbnailMetadata(accessToken: string, fileId: string): Promise<DriveThumbnailMetadata> {
    try {
      const { data } = await this.client(accessToken).files.get({
        fileId,
        fields: 'id,name,mimeType,thumbnailLink,iconLink,modifiedTime',
        supportsAllDrives: true,
      });
      return {
        id: data.id || '',
        name: data.name || '',
        mimeType: data.mimeType || 'application/octet-stream',
        thumbnailLink: data.thumbnailLink || undefined,
        iconLink: data.iconLink || undefined,
        modifiedTime: data.modifiedTime || undefined,
      };
    } catch (error) {
      this.handleGoogleError(error);
    }
  }

  async fetchThumbnail(
    accessToken: string,
    thumbnailLink: string,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const response = await fetch(thumbnailLink, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 403 || response.status === 404) {
      throw new NotFoundException('Thumbnail unavailable');
    }
    if (!response.ok) {
      throw new ServiceUnavailableException('Google thumbnail unavailable');
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'image/jpeg',
    };
  }

  private client(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return google.drive({ version: 'v3', auth });
  }

  private normalizeFile(file: drive_v3.Schema$File): DriveFile {
    return {
      id: file.id || '',
      name: file.name || '',
      mimeType: file.mimeType || 'application/octet-stream',
      size: file.size || undefined,
      webViewLink: file.webViewLink || undefined,
      webContentLink: file.webContentLink || undefined,
      thumbnailLink: file.thumbnailLink || undefined,
      iconLink: file.iconLink || undefined,
      exportLinks: file.exportLinks || undefined,
      parents: file.parents || undefined,
      createdTime: file.createdTime || undefined,
      modifiedTime: file.modifiedTime || undefined,
    };
  }

  private handleGoogleError(error: unknown): never {
    const status = this.extractStatus(error);
    if (status) {
      this.handleStatus(status);
    }
    this.logger.error('Google Drive API error', error instanceof Error ? error.stack : String(error));
    throw new ServiceUnavailableException('Google Drive API unavailable');
  }

  private extractStatus(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null) {
      const maybeError = error as { code?: number; response?: { status?: number } };
      return maybeError.response?.status || maybeError.code;
    }
    return undefined;
  }

  private handleStatus(status: number): never {
    if (status === 401) throw new UnauthorizedException('Drive token is invalid');
    if (status === 403) throw new ForbiddenException('Drive access forbidden');
    if (status === 404) throw new NotFoundException('Drive file not found');
    if (status === 429) throw new HttpException('Drive API rate limit', 429);
    if (status >= 500) throw new ServiceUnavailableException('Google Drive API unavailable');
    throw new HttpException('Google Drive request failed', status);
  }
}
