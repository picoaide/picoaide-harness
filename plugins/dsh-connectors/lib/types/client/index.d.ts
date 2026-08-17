import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { ConnectorsList } from './ConnectorsSection.tsx';
/**
 * Connectors client half: exports the connector list surface for the skill
 * center (rendered by the enterprise skill-center panel), mirroring
 * WorkBuddy's connector center. No slots of its own — the skill center owns
 * placement.
 */
export declare const name = "pico-connectors-client";
export declare const inject: never[];
export declare function apply(_ctx: ClientContext): void;
export { ConnectorsList };
