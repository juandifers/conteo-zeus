/**
 * Vitest, sharing the real build configuration.
 *
 * Merged rather than written fresh: the unit tests compile the same JSX with
 * the same plugin as the application does, so a transform that works here and
 * not in `vite build` cannot exist. `vite.config.ts` is otherwise ignored the
 * moment this file exists, which is a quiet way to lose the React plugin.
 *
 * The one addition is the exclusion. Vitest and Playwright share `tests/`, and
 * without it Vitest would try to run the offline suite in Node, where
 * `@playwright/test` has no fixtures and every file fails on import.
 */
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: ['**/node_modules/**', '**/dist/**', 'tests/offline/**'],
    },
  }),
)
