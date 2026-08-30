import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { RequestTrace } from '../common/logging/request-trace';
import { PersonalizeRequestDto, PersonalizeResponseDto } from './dto/personalize.dto';
import { PersonalizeService } from './personalize.service';

@Controller()
export class PersonalizeController {
  constructor(private readonly service: PersonalizeService) {}

  /**
   * POST /personalize
   *
   * The response body is exactly { answer, confidence, sourcesUsed }. The
   * engine's internals are available through `verbose: true`, which adds a
   * `meta` block, so the default contract stays clean for the app while the
   * full reasoning is one flag away for debugging.
   */
  @Post('personalize')
  @HttpCode(200)
  async personalize(
    @Body() body: PersonalizeRequestDto,
    @Headers('x-request-id') requestId?: string,
  ): Promise<PersonalizeResponseDto> {
    const trace = new RequestTrace(requestId);
    const result = await this.service.personalize({
      userId: body.userId,
      question: body.question,
      verbose: body.verbose,
      trace,
    });

    return {
      answer: result.answer,
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
      ...(result.meta ? { meta: result.meta } : {}),
    };
  }
}
