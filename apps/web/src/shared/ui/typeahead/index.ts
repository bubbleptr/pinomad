// The search-source contract the composer's trigger menus (and later a
// typeahead) consume, ported from Astryx's Typeahead module.
export type { SearchableItem, SearchSource } from "./types";
export { createStaticSource } from "./create-static-source";
export type { CreateStaticSourceOptions } from "./create-static-source";
export { groupItems, getItemGroup } from "./group-items";
export type { ItemGroup } from "./group-items";
