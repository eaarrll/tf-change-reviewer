import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "evals/results/**",
      "evals/fixtures/**",
      "evals/scenarios/**",
      "evals/.work/**",
      ".tf-plugin-cache/**",
      "test/fixtures/**",
      ".vitest/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
