# MemRead

<p align="center">
  <a href="https://github.com/DavidNgugi/memread/releases"><img src="https://img.shields.io/github/v/tag/DavidNgugi/memread?label=version&sort=semver&cacheSeconds=60" alt="Latest version" /></a>
  <a href="https://github.com/DavidNgugi/memread/actions/workflows/release.yml"><img src="https://github.com/DavidNgugi/memread/actions/workflows/release.yml/badge.svg" alt="Release build" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f6f5f" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20Apple%20silicon-172d2a" alt="macOS on Apple silicon" />
</p>

**A fast, local-first macOS storage explorer.**

**Latest version:** [`v0.1.0`](https://github.com/DavidNgugi/memread/releases/tag/v0.1.0)

**Requirements:** macOS on Apple silicon, Full Disk Access
**License:** [MIT](LICENSE)

MemRead shows where disk space is going without uploading file names, paths, or measurements. Browse your home folder, inspect large items as their sizes are calculated in the background, and move confirmed items to Trash without permanently deleting them.

## Highlights

- Browse folders immediately while recursive size measurement continues in the background.
- See live scan progress, recently measured items, and a Calculating state for unresolved sizes.
- Mark incomplete measurements as Partial when macOS protects or denies access to content.
- Search the current directory and navigate with breadcrumbs.
- Move eligible items to macOS Trash after confirmation.
- Use measured, confirmation-gated shortcuts for Xcode Derived Data, Archives, Yarn cache, CocoaPods cache, and unavailable simulator devices.
- Save personal cleanup shortcuts for folders inside your home directory; protected app containers and credentials remain unavailable.
- Protect app data, credentials, and developer-tool directories from accidental removal.
- Open a menu-bar quick glance with available storage and the largest scanned items.
- Cancel stale background scans automatically when you navigate to another folder.

## Privacy And Safety

MemRead is local-first: it does not send storage information, file names, or paths to a server.

macOS separately protects some data owned by other apps, including Library Containers and Group Containers. MemRead intentionally excludes those containers from automatic measurement to avoid repeated system privacy prompts. A displayed Partial size means protected or unreadable content was omitted.

MemRead never permanently deletes an item. Eligible removals are moved to macOS Trash, where they remain recoverable until you empty Trash yourself.

## Requirements

- macOS on Apple silicon
- Node.js 24 or later
- Rust stable with Clippy and rustfmt
- Xcode Command Line Tools

The app guides you through Full Disk Access on first run. Grant it to the installed MemRead application, then quit and reopen the app before verifying access.

## Install

Download the latest DMG from [GitHub Releases](https://github.com/DavidNgugi/memread/releases), open it, and copy MemRead.app to Applications.

For a local development build:

~~~sh
npm ci
npm run tauri build
open src-tauri/target/release/bundle/macos/MemRead.app
~~~

## Development

~~~sh
npm ci
npm run tauri dev
~~~

Useful checks:

~~~sh
npm run build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
~~~

## Releases

Pushing a tag beginning with v triggers the GitHub Actions release workflow. It verifies formatting, linting, Rust tests, and the frontend build before creating and attaching a macOS DMG to the GitHub release.

~~~sh
git tag v0.1.0
git push origin v0.1.0
~~~

## Architecture

- **Desktop shell:** Tauri 2 and Rust
- **Interface:** React 19, TypeScript, and Vite
- **Measurement:** cancellable Rust background workers that emit incremental updates to the UI

## Contributing

Contributions are welcome. Please open an issue before starting substantial work, keep changes focused, and ensure the checks above pass before submitting a pull request.

## License

MemRead is licensed under the [MIT License](LICENSE).
