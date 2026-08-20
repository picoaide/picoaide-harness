import { type JobRecord } from '../jobs.ts';
import type { CronController } from './controller.ts';
export declare function JobEditor({ controller, job, onClose }: {
    controller: CronController;
    job?: JobRecord;
    onClose: () => void;
}): JSX.Element;
