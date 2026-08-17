import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StalzoneModule } from './stalzone/stalzone.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ApiModule,
    StalzoneModule,
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
})
export class AppModule {}
