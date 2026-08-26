/**
 * Public surface of the counting domain.
 *
 * Note what is *not* here: nothing about tabs, CP850, `rawRow`, column order or
 * `Grupo1..5`. That vocabulary belongs to src/zeus/, which this package never
 * imports — see types.ts.
 */
export type {
  Item,
  ItemState,
  CountEvent,
  CountEventBase,
  SetCountEvent,
  AddCountEvent,
  UnchangedEvent,
  RetractEvent,
  QuantityEvent,
  CountEventDraft,
  Session,
  SessionMeta,
  SessionSource,
  ExportRecord,
} from './types';
export {
  resolve,
  resolveAll,
  compareEvents,
  changesResolution,
  undoLast,
  type Resolution,
} from './fold';
export {
  itemVariance,
  bookValue,
  exposureQuantity,
  exposureValue,
  type Variance,
  type VarianceClass,
} from './variance';
export {
  isNormalisedInstant,
  assertNormalisedInstant,
  nowInstant,
  INSTANT_PATTERN,
} from './time';
export {
  summarizeSession,
  resolveSession,
  isWriteOff,
  type SessionSummary,
  type ItemSummary,
  type UnverifiedItem,
  type Exposure,
  type Coverage,
  type SummaryOptions,
} from './session';
export {
  MemoryRepository,
  EventConflictError,
  SequenceConflictError,
  sameEvent,
  validateEvent,
  type CountRepository,
  type DeviceRepository,
  type DeviceIdentity,
  type ExportRepository,
} from './repository';
