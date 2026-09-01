/**
 * The boundary between the Zeus adapter and the counting domain.
 *
 * This is the only package that imports both. Anything above it (the store,
 * the UI) talks to the domain; anything below it is a file format.
 */
export {
  importZeusFile,
  importZeusBytes,
  parseZeusBytes,
  sourceHashOf,
  catalogueFaults,
  describeFaults,
  inversionRate,
  toItems,
  CatalogueError,
  type CatalogueFault,
  type ImportOptions,
} from './importZeus';
export {
  adjustmentFilename,
  exportAdjustment,
  generateAdjustment,
  sourceIntact,
  writeAdjustment,
  type SealedAdjustment,
  type Adjustment,
  type ExportAdjustmentOptions,
  type GenerateAdjustmentOptions,
} from './exportAdjustment';
export {
  verifyWriteBack,
  PostingVerificationError,
  type VerifyWriteBackOptions,
} from './verifyWriteBack';
export {
  ingestZeusBytes,
  ingestZeusFile,
  toWire,
  catalogueDifferences,
  sourceHashOfBytes,
  type CatalogueRow,
  type CatalogueRowWire,
  type IngestedFile,
} from './ingest';
export {
  VERIFIED_PARAMETERS,
  isVerifiedTriple,
  unverifiedParameters,
  type PostingParameters,
} from './parameters';
export {
  BUNDLE_FORMAT,
  bundleJson,
  type BundleAction,
  type BundleCounter,
  type BundleSeals,
  type SessionBundle,
} from './bundle';
