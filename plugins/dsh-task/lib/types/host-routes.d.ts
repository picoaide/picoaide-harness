import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { HostTaskService } from './host-service.ts';
export declare function makeTaskRoutes(service: HostTaskService): WebRoute[];
