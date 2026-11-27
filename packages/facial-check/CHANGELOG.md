# Changelog

All notable changes to `facial-check` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While in `0.x`, minor releases may contain breaking changes; they are called out explicitly.

## [Unreleased]

## [0.1.0]

### Added

- Project scaffolding: `package.json`, strict TypeScript, tsup build (ESM + CJS + `.d.ts`/`.d.cts`), ESLint, Vitest (jsdom).
- Public entry points `facial-check`, `facial-check/react`, `facial-check/core` and `facial-check/detectors` (empty placeholders for now).
- `face-api.js@0.22.2` and `@mediapipe/tasks-vision` as dependencies; React and React DOM as optional peer dependencies.
