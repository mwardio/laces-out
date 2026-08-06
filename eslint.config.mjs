import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((configuration) => ({
    ...configuration,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    // ADR 0001: the API and worker are separate processes. Shared provider-neutral logic belongs in
    // packages/*, so a cross-app import is a build error rather than a review comment.
    files: ["apps/api/**/*.ts", "apps/worker/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/apps/api/*",
                "**/apps/worker/*",
                "../../api/*",
                "../../worker/*",
                "@laces-out/api",
                "@laces-out/api/*",
                "@laces-out/worker",
                "@laces-out/worker/*",
              ],
              message:
                "apps/api and apps/worker must not import each other (ADR 0001). Move shared logic into packages/*.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
