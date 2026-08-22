import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { HostCronService } from './host-service.ts';
export declare function makeCronRoutes(service: HostCronService): WebRoute[];
