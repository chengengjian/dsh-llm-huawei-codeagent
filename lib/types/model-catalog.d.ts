import type { HuaweiCatalogModel } from './adapter.ts';
/** Parse CodeAgent catalog records, including routed models nested under Auto entries. */
export declare function parseModelCatalog(payload: unknown): HuaweiCatalogModel[];
