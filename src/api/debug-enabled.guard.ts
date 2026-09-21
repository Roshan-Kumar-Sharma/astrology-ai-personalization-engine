import { CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';

/**
 * Takes the whole debug surface away when `DEBUG_ENDPOINTS_ENABLED` is off.
 *
 * 404 rather than 403: with the surface disabled, these routes should look like
 * they were never mounted rather than like something worth probing for. A 403
 * confirms the endpoint exists, which is exactly the fact worth withholding.
 */
@Injectable()
export class DebugEnabledGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(): boolean {
    if (!this.cfg.DEBUG_ENDPOINTS_ENABLED) throw new NotFoundException();
    return true;
  }
}
