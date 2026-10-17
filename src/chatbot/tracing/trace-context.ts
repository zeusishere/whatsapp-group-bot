import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceCollector } from './trace-collector.js';

/**
 * Propagates "which span am I inside?" through async calls without threading a parameter through
 * every function. `TraceCollector.span` reads it to set `parent_span_id`, so nested steps form a
 * tree automatically, including across `await` boundaries and `Promise.all` branches.
 */
export interface TraceFrame {
  collector: TraceCollector;
  spanId: string;
}

export const traceContext = new AsyncLocalStorage<TraceFrame>();
