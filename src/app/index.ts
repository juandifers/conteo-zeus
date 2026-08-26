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
  type ImportOptions,
} from './importZeus';
export {
  exportAdjustment,
  generateAdjustment,
  sourceIntact,
  type Adjustment,
  type ExportAdjustmentOptions,
  type GenerateAdjustmentOptions,
} from './exportAdjustment';
