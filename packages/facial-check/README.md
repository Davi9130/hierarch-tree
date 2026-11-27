# facial-check

SDK for camera capture, face detection, facial analysis and Face Liveness flows. It has a framework-agnostic core and React bindings.

> **Status: 0.x, under construction.** This release only contains the project scaffolding. The public entry points exist but don't export anything yet. Each feature (camera, engines, analysis, challenges, PAD, session, React) ships in its own release. Full documentation comes with the first functional release.

## Installation

```bash
npm install facial-check
```

React and React DOM are **peer dependencies**. They are optional and only needed for `facial-check/react`, and the package never bundles them, so your app always uses its own copy. `face-api.js@0.22.2` and `@mediapipe/tasks-vision` are installed as regular dependencies.

## Entry points

| Import                   | Contents                                                    |
| ------------------------ | ----------------------------------------------------------- |
| `facial-check`           | Programmatic API (`FacialCheck`, public types)              |
| `facial-check/react`     | React components and hooks (`FaceLiveness`, `useFacialCheck`) |
| `facial-check/core`      | Building blocks (`FaceEngine`, `FaceAnalyzer`, …)           |
| `facial-check/detectors` | Standalone detectors (`BlinkDetector`, `MouthDetector`, …)  |

Each entry point is published as ESM (`.js` + `.d.ts`) and CommonJS (`.cjs` + `.d.cts`). Only these subpaths and `facial-check/package.json` can be imported. Internal modules are not part of the public API.

## Privacy

All processing runs locally in the browser. By default, the SDK does not send images or video anywhere, does not store them, and does not log biometric data. Detecting facial movements does **not** prove that the user is a real person. Presence challenges are kept separate from Presentation Attack Detection (PAD).

## Development

This package lives in `packages/facial-check/` of the `hierarch-tree` repository. It is an independent npm project with its own lockfile, so run all commands from this directory:

```bash
npm install
npm run lint       # ESLint (typescript-eslint strict + react-hooks)
npm run typecheck  # tsc --noEmit (strict)
npm test           # Vitest (jsdom)
npm run build      # tsup → dist/ (ESM + CJS + .d.ts/.d.cts)
npm run check      # all of the above
```

Source layout:

```text
src/
  core/        session, config, event emitter
  camera/      MediaDevices capture
  engines/     FaceEngine contract + face-api.js / MediaPipe engines
  analysis/    face, eye, mouth and head-pose analysis
  detectors/   public `facial-check/detectors` barrel
  challenges/  liveness challenge engine
  pad/         Presentation Attack Detection contracts
  react/       components and hooks/
  types/       public types
models/        model weights (see engine docs)
examples/react demo app
tests/         Vitest suites
```

## Versioning and publishing

This package follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: breaking changes to the public API, meaning anything exported from the four entry points or the shape of results and events.
- **MINOR**: new features that stay backwards compatible, such as new challenges, engines, detectors or options.
- **PATCH**: backwards-compatible bug fixes.

While the version is `0.x`, a MINOR bump may include breaking changes, and the CHANGELOG calls them out. Every release adds an entry to [`CHANGELOG.md`](./CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/) format).

To publish (maintainers):

```bash
npm version <patch|minor|major>   # bumps package.json and tags
npm publish                       # prepublishOnly runs lint, typecheck, test and build
```

`publishConfig` publishes to the public npm registry with `access: public`.

## License

MIT. See [LICENSE](./LICENSE).
