import { monotonicFactory } from 'ulid';

/**
 * Single source of identifiers (turn, span, message, retrieval, thread).
 *
 * ULIDs rather than UUIDv4: they are unique just the same, but also sort by creation time, so
 * `ORDER BY id` on any trace table is chronological and ids are easy to eyeball in logs.
 * The monotonic factory guarantees strictly increasing ids even within the same millisecond,
 * which matters because a turn creates many spans in a burst.
 */
const factory = monotonicFactory();

export const newId = (): string => factory();
