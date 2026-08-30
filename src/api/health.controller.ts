import { Controller, Get } from '@nestjs/common';
import { UpstreamClient } from '../upstream/upstream.client';

@Controller()
export class HealthController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      cache: this.upstream.cacheStats(),
    };
  }
}
