import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SafeUser } from '../auth/auth.service';
import { BulkFileOperationDto } from './dto/bulk-file-operation.dto';
import { CompleteUploadSessionDto } from './dto/complete-upload-session.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { LargeFilesQueryDto } from './dto/large-files-query.dto';
import { ListFilesQueryDto } from './dto/list-files-query.dto';
import { TrashFilesQueryDto } from './dto/trash-files-query.dto';
import { UploadFromUrlDto } from './dto/upload-from-url.dto';
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

  @Post('upload-from-url')
  uploadFromUrl(@CurrentUser() user: SafeUser, @Body() dto: UploadFromUrlDto) {
    return this.filesService.uploadFromUrl(user.id, dto);
  }

  @Get('large')
  largeFiles(@CurrentUser() user: SafeUser, @Query() query: LargeFilesQueryDto) {
    return this.filesService.getLargeFiles(user.id, query);
  }

  @Get('cleanup-suggestions')
  cleanupSuggestions(@CurrentUser() user: SafeUser) {
    return this.filesService.getCleanupSuggestions(user.id);
  }

  @Post('bulk/delete')
  bulkDelete(@CurrentUser() user: SafeUser, @Body() dto: BulkFileOperationDto) {
    return this.filesService.bulkDelete(user.id, dto);
  }

  @Post('bulk/restore')
  bulkRestore(@CurrentUser() user: SafeUser, @Body() dto: BulkFileOperationDto) {
    return this.filesService.bulkRestore(user.id, dto);
  }

  @Get('trash')
  listTrash(@CurrentUser() user: SafeUser, @Query() query: TrashFilesQueryDto) {
    return this.filesService.listTrash(user.id, query);
  }

  @Patch(':accountId/:fileId/restore')
  restoreFile(
    @CurrentUser() user: SafeUser,
    @Param('accountId') accountId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.filesService.restoreTrashedFile(user.id, accountId, fileId);
  }

  @Get('preview/:accountId/:fileId')
  getPreviewUrl(
    @CurrentUser() user: SafeUser,
    @Param('accountId') accountId: string,
    @Param('fileId') fileId: string,
  ) {
    return this.filesService.getPreviewUrl(user.id, accountId, fileId);
  }

  @Get('stream/:accountId/:fileId')
  streamFile(
    @CurrentUser() user: SafeUser,
    @Param('accountId') accountId: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ) {
    return this.filesService.streamFile(user.id, accountId, fileId, res);
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
