# Contributing

Keep changes focused on the local LaTeX workflow. Describe the user-visible behavior, the reason for the change, and how it was checked.

## Development

~~~sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
~~~

For engine or project-file changes, run the relevant integrations with a compatible local TeX setup:

~~~sh
npm run test:session
npm run test:page-tools
npm run test:host
~~~

## Expectations

- Use synthetic fixtures and temporary project copies. Do not commit manuscripts, API keys, user directories, project indexes, local settings, logs, generated PDFs, or runtime downloads.
- Preserve source boundaries, captions, labels, undo behavior, and per-project file isolation.
- Treat TeX output as authoritative. Keep the existing fallback for approximate or unsafe local overlays.
- Measure the affected stage when claiming a performance improvement. State document size, toolchain, sample count, and whether browser drawing was included.
- Keep dependency and runtime changes explicit. Native compatibility changes need exact version guards and real-engine regression checks.
- Preserve upstream MIT notices and the dependency attribution listed in [THIRD_PARTY_NOTICES.md](../docs/THIRD_PARTY_NOTICES.md).

The public tree contains only application source, general examples, tests, and documentation. Local projects belong in .local or an external project directory; .runtime is for generated state. Archive operations must remain non-destructive.
