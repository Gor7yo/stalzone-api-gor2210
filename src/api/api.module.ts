import { Module } from '@nestjs/common';
import { StalzoneModule } from 'src/stalzone/stalzone.module';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';

@Module({
  imports: [StalzoneModule],
  controllers: [ApiController],
  providers: [ApiService],
})
export class ApiModule {}
