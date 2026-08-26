/**
 * Public surface of the Zeus adapter.
 *
 * Nothing outside src/zeus/ needs to know about tabs, CP850 or column
 * positions — consumers work with ZeusFile / ZeusItem and these functions.
 */
export { decodeCp850, encodeCp850 } from './cp850';
export { formatNumber, parseNumber, formatExcelGeneral } from './formatNumber';
// Decimal arithmetic is not Zeus-specific; it lives in src/lib/ and is re-exported
// here only because the adapter's own numeric rules (§3) are the reason it exists.
export { subtractDecimal } from '../lib/decimal';
export { parseTxt } from './parseTxt';
export { parseXls, type ParseXlsOptions } from './parseXls';
export { writeTxt, UncountedItemsError, type WriteTxtOptions } from './writeTxt';
export { reencode } from './reencode';
export {
  ZEUS_COLUMNS,
  ZEUS_FIELD_COUNT,
  NOT_APPLICABLE,
  type ZeusFile,
  type ZeusItem,
} from './types';
