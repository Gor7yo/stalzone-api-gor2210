import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { AccountGuard, type AccountRequest } from './account.guard';
import { REVIEW_NICK, REVIEW_TEXT } from './reviews';
import { ReviewsService } from './reviews.service';

class ReviewDto {
  @IsString()
  @Length(REVIEW_NICK.min, REVIEW_NICK.max)
  nick!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsString()
  @Length(REVIEW_TEXT.min, REVIEW_TEXT.max)
  text!: string;
}

class ListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;
}

/** Отзывы о сервисе: список — всем, оставить — с аккаунтом и привязанным Telegram. */
@Controller('api/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  list(@Query() q: ListQuery) {
    return this.reviews.list(q.before);
  }

  @Get('me')
  @UseGuards(AccountGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() req: AccountRequest) {
    return this.reviews.status(req.account);
  }

  @Post()
  @UseGuards(AccountGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  create(@Req() req: AccountRequest, @Body() dto: ReviewDto) {
    return this.reviews.create(req.account, dto);
  }
}
