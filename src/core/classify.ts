/**
 * Player classification and event interpretation.
 *
 * The shipped data README suggests you can tell humans from bots by event type
 * ("Humans generate Position, Bots generate BotPosition"). That is wrong: across
 * the full dataset 636 `Position` events and 115 `Loot` events sit inside *bot*
 * files. Event type reflects what the telemetry happened to label, not who the
 * subject is.
 *
 * The only signal that holds for all 1,243 files is the shape of `user_id`:
 * a UUID means human, a bare integer means bot. Every file in the dataset falls
 * cleanly into one of those two buckets with no exceptions.
 */
import { EVENT_TYPES, isMovement, isFatal, markerKindFor } from './types';
import type { EventType } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;

export type SubjectKind = 'human' | 'bot' | 'unknown';

/**
 * Classify a subject by user_id. This is the authoritative human/bot signal.
 */
export function classifyUserId(userId: string): SubjectKind {
  if (UUID_RE.test(userId)) return 'human';
  if (NUMERIC_RE.test(userId)) return 'bot';
  return 'unknown';
}

export function isBotUserId(userId: string): boolean {
  return classifyUserId(userId) === 'bot';
}

/** Recover the user_id from a parquet filename: `{user_id}_{match_id}.nakama-0`. */
export function userIdFromFilename(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const separator = base.indexOf('_');
  return separator === -1 ? base : base.slice(0, separator);
}

/** Recover the match_id from a parquet filename. */
export function matchIdFromFilename(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const separator = base.indexOf('_');
  return separator === -1 ? '' : base.slice(separator + 1);
}

export interface EventInterpretation {
  kind: ReturnType<typeof markerKindFor>;
  fatal: boolean;
  movement: boolean;
  /** Who the event involved, besides the subject. */
  counterparty: 'human' | 'bot' | 'environment' | null;
  label: string;
}

/**
 * Interpret an event relative to the journey's subject.
 *
 * Every event is subject-relative: a `BotKilled` row in a human's file means
 * *that human* was killed by a bot. Rendering these as global match events
 * would double-count and mislabel roughly 30% of combat.
 */
export function interpretEvent(index: number): EventInterpretation {
  const name: EventType = EVENT_TYPES[index] ?? 'Position';
  const movement = isMovement(index);
  const fatal = isFatal(index);
  const kind = markerKindFor(index);

  let counterparty: EventInterpretation['counterparty'] = null;
  switch (name) {
    case 'Kill':
      counterparty = 'human';
      break;
    case 'BotKill':
      counterparty = 'bot';
      break;
    case 'Killed':
      counterparty = 'human';
      break;
    case 'BotKilled':
      counterparty = 'bot';
      break;
    case 'KilledByStorm':
      counterparty = 'environment';
      break;
    default:
      counterparty = null;
  }

  return { kind, fatal, movement, counterparty, label: describeEvent(name) };
}

function describeEvent(name: EventType): string {
  switch (name) {
    case 'Position':
    case 'BotPosition':
      return 'Moved';
    case 'Loot':
      return 'Looted an item';
    case 'Kill':
      return 'Killed a player';
    case 'Killed':
      return 'Killed by a player';
    case 'BotKill':
      return 'Killed a bot';
    case 'BotKilled':
      return 'Killed by a bot';
    case 'KilledByStorm':
      return 'Died to the storm';
  }
}