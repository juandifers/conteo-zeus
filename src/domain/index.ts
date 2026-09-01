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
  NoteEvent,
  FinishEvent,
  ReopenEvent,
  SessionScopedEvent,
  QuantityEvent,
  CountEventDraft,
  CounterEventDraft,
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
  isItemEvent,
  undoLast,
  type ItemEvent,
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
  canonicalEvent,
  genesisHash,
  chainHash,
  chainEvents,
  headHash,
  verifyChain,
  checkFinishManifest,
  UnchainableEventError,
  type ChainLink,
  type ChainVerdict,
  type FinishManifest,
  type ManifestVerdict,
  type StoredLink,
} from './chain';
export {
  deriveCounterEstado,
  postFinishSeqs,
  sessionReadyToSeal,
  type CounterSyncState,
  type CounterVerdict,
  type DeviceEstado,
  type SealBlocker,
  type StoredCounterEvent,
} from './sync';
export {
  MemoryRepository,
  MemoryChain,
  EventConflictError,
  SequenceConflictError,
  sameEvent,
  validateEvent,
  type CountRepository,
  type CounterChainRepository,
  type ChainedEvent,
  type SyncState,
  type DeviceRepository,
  type DeviceIdentity,
  type ExportRepository,
} from './repository';
export {
  deriveFamilies,
  familyPrefix,
  type FamilyGroup,
} from './families';
export {
  assignmentCoverage,
  unassignedByFamily,
  dispatchBlockers,
  type Assignment,
  type AssignmentCoverage,
  type Counter,
  type CounterEstado,
  type CoverageGap,
  type DispatchBlocker,
  type DispatchInput,
  type Section,
  type SessionEstado,
} from './assignment';
export {
  counterItem,
  counterPayload,
  COUNTER_PAYLOAD_FIELDS,
  COUNTER_SESSION_FIELDS,
  COUNTER_COUNTER_FIELDS,
  COUNTER_SECTION_FIELDS,
  COUNTER_ITEM_FIELDS,
  NEVER_SENT_TO_A_COUNTER,
  type CounterItem,
  type CounterPayload,
  type CounterPayloadInput,
  type CounterSection,
  type CounterSessionView,
  type CounterView,
} from './counterView';
