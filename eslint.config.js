import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export const dangerouslySetInnerHtmlRule = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message:
    'dangerouslySetInnerHTML is only allowed in ArticleContent.tsx (sanitised feed HTML). See spec §10.5.',
};

export const sqlTemplateLiteralRule = {
  selector:
    "CallExpression[callee.property.name='prepare'] > TemplateLiteral[expressions.length>0]",
  message: 'Do not interpolate into SQL passed to prepare(); use bind() with placeholders.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      'coverage/**',
      'docs/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-syntax': ['error', dangerouslySetInnerHtmlRule, sqlTemplateLiteralRule],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    ...jsxA11y.flatConfigs.recommended,
  },
  {
    // Single allowed home for raw HTML injection.
    files: ['**/ArticleContent.tsx'],
    rules: { 'no-restricted-syntax': ['error', sqlTemplateLiteralRule] },
  },
);
