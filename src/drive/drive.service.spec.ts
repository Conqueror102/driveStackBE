import { google } from 'googleapis';
import { DriveService } from './drive.service';

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
      })),
    },
    drive: jest.fn(),
  },
}));

describe('DriveService with mocked Google APIs', () => {
  let service: DriveService;

  beforeEach(() => {
    service = new DriveService();
    jest.clearAllMocks();
  });

  it('maps Google quota strings to bigint values', async () => {
    (google.drive as jest.Mock).mockReturnValue({
      about: {
        get: jest.fn().mockResolvedValue({
          data: {
            storageQuota: {
              limit: '1000',
              usage: '250',
              usageInDrive: '200',
            },
          },
        }),
      },
    });

    await expect(service.getQuota('token')).resolves.toEqual({
      limit: 1000n,
      usage: 250n,
      usageInDrive: 200n,
    });
  });

  it('normalizes Google file list responses', async () => {
    (google.drive as jest.Mock).mockReturnValue({
      files: {
        list: jest.fn().mockResolvedValue({
          data: {
            nextPageToken: 'next-page',
            files: [
              {
                id: 'file-1',
                name: 'Report.pdf',
                mimeType: 'application/pdf',
                size: '123',
                webViewLink: 'https://drive.google.com/file',
              },
            ],
          },
        }),
      },
    });

    await expect(service.listFiles('token')).resolves.toEqual({
      nextPageToken: 'next-page',
      files: [
        expect.objectContaining({
          id: 'file-1',
          name: 'Report.pdf',
          mimeType: 'application/pdf',
          size: '123',
        }),
      ],
    });
  });
});
