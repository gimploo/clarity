/**
 * The parquet schema contract shared by the browser loader and the verifier.
 *
 * This lives apart from loader.ts on purpose: loader.ts reads `import.meta.env`,
 * which only exists under Vite, so it cannot be imported by a plain Node script.
 * Keeping the column list here means the guard in scripts/verify-loader.ts always
 * checks the same list the app actually requests.
 */

/** Columns the app needs to place samples and read events. */
export const COLUMNS = ['x', 'y', 'z', 'ts', 'event'] as const;

/**
 * Columns that identify the subject of a file.
 *
 * These are cheap but *mandatory*: hyparquet only decodes the columns listed in
 * `columns`, and the manifest carries only path, day, byte length and bot flag --
 * not `map_id`, `match_id` or `user_id`. Omitting them leaves every row without a
 * map, and the loader then rejects every single file as "unknown map_id".
 */
export const IDENTITY_COLUMNS = ['map_id', 'match_id', 'user_id'] as const;

/** Full read list, in the order hyparquet will decode them. */
export const READ_COLUMNS: readonly string[] = [...COLUMNS, ...IDENTITY_COLUMNS];