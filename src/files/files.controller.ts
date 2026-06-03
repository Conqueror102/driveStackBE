import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SafeUser } from '../auth/auth.service';
import { CompleteUploadSessionDto } from './dto/complete-upload-session.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { ListFilesQueryDto } from './dto/list-files-query.dto';
import { FilesService } from './files.service';

@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get()
  list(@CurrentUser() user: SafeUser, @Query() query: ListFilesQueryDto) {
    return this.filesService.listFiles(user.id, query);
  }

  @Post('upload-session')
  createUploadSession(@CurrentUser() user: SafeUser, @Body() dto: CreateUploadSessionDto) {
    return this.filesService.createUploadSession(user.id, dto);
  }

  @Get('upload-session/:id')
  getUploadSession(@CurrentUser() user: SafeUser, @Param('id') sessionId: string) {
    return this.filesService.getUploadSession(user.id, sessionId);
  }

  @Patch('upload-session/:id')
  async completeUpload(
    @CurrentUser() user: SafeUser,
    @Param('id') sessionId: string,
    @Body() dto: CompleteUploadSessionDto,
  ) {
    return this.filesService.completeUpload(user.id, sessionId, dto);
  }

  @Get(':accountId/:fileId/links')
  getFileLinks(
    @CurrentUser() user: SafeUser,
    @Param('accountId') accountId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.filesService.getFileLinks(user.id, accountId, fileId);
  }

  @Get(':accountId/:fileId/thumbnail')
  async getThumbnail(
    @CurrentUser() user: SafeUser,
    @Param('accountId') accountId: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ) {
    const thumbnail = await this.filesService.getThumbnail(user.id, accountId, fileId);
    res.setHeader('Content-Type', thumbnail.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(thumbnail.bytes);
  }

  @Delete(':accountId/:fileId')
  async deleteFile(
    @CurrentUser() user: SafeUser,
    @Param('accountId') accountId: string,
    @Param('fileId') fileId: string,
  ) {
    await this.filesService.deleteFile(user.id, accountId, fileId);
    return { success: true };
  }
}
