import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class PersonalizeRequestDto {
  @IsString()
  @Matches(/^[\w-]{1,64}$/, { message: 'userId must be 1-64 word characters or hyphens' })
  userId!: string;

  @IsString()
  // Upper bound is a safety control as much as a validation rule: it caps the
  // token cost of a single request and blunts prompt-stuffing attempts.
  @Length(3, 1000, { message: 'question must be between 3 and 1000 characters' })
  question!: string;

  /** Include the full engine trace in the response. Off by default. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  verbose?: boolean;
}

export class PersonalizeResponseDto {
  answer!: string;
  confidence!: 'HIGH' | 'MEDIUM' | 'LOW';
  sourcesUsed!: string[];
  /** Present only when `verbose` was requested. */
  meta?: Record<string, unknown>;
}
