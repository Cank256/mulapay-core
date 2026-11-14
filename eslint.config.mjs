// Rules mirror provider_gateway/.eslintrc.json (spec section 13) so the two repositories
// read alike. This file uses ESLint's flat config format because ESLint 8 (the gateway's
// legacy .eslintrc format) is end-of-life. Additions over the gateway are marked "core:".
import eslint from '@eslint/js';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

/** core: raw SQL must use placeholders (spec section 11). */
const SQL_CALLEE = /^(query|execute|raw|unsafe)$/;
const noInterpolatedSql = [
  {
    selector: `CallExpression[callee.property.name=${SQL_CALLEE}] > TemplateLiteral[expressions.length>0]`,
    message:
      'Do not interpolate values into SQL strings. Use the drizzle sql`` tag or $n placeholders.',
  },
  {
    selector: `CallExpression[callee.property.name=${SQL_CALLEE}] > BinaryExpression[operator="+"]`,
    message:
      'Do not build SQL by string concatenation. Use the drizzle sql`` tag or $n placeholders.',
  },
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/db/migrations/**', 'docs/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettierRecommended,
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      // core: the spec forbids `any` outright (gateway: warn)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Nest lifecycle hooks and interface implementations are async without awaiting.
      '@typescript-eslint/require-await': 'off',
      // core: `@ts-ignore` only with a comment naming the reason
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', 'ts-expect-error': 'allow-with-description' },
      ],
      // core: no console; use the Pino logger
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...noInterpolatedSql],
    },
  },
  {
    // Tests read untyped JSON response bodies and build partial mocks; the type-safety
    // rules below add noise there without protecting runtime code (same as the gateway).
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: 'readonly', console: 'readonly' },
    },
  }
);
