import { Module } from '@nestjs/common';
import { OBJECT_STORAGE } from './object-storage.port';
import { S3ObjectStorage } from './s3-object-storage';

/** Object storage for KYC documents and generated files (spec 4.4, 6.13). */
@Module({
  providers: [S3ObjectStorage, { provide: OBJECT_STORAGE, useExisting: S3ObjectStorage }],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
