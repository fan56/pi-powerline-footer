# Changelog

## [1.2.0] - 2026-08-02

### Added

- Cache hit rate segment (💰 CHxx.x%) in the footer: cumulative cache read/write + latest assistant message hit rate, shown only when cache activity exists
- Editor top border info line: current directory (📁) and git branch (⎇), with scroll-up indicator when the view is scrolled
- Re-assert the custom editor component after session start (guards against reload reverting to the default editor)

## [1.1.0] - 2026-08-01

### Added

- Full thinking level support (off/minimal/low/medium/high/xhigh/max)

## [1.0.0] - 2026-07-24

### Changed

- npm package name scoped to @aiwayds/pi-powerline-footer
- Release 1.0.0 with gallery preview image

## [0.2.0] - 2025-07-12

### Added

- Last-request widget: displays the most recent user message below the editor input (truncated to 200 chars), updates on session_start, agent_end, and tool_result

## [0.1.0] - 2025-07-11

### Added

- Powerline-style footer with segments: cwd, git branch, provider, model+thinking, context usage, message count, tool count, live clock
- Color-coded context usage (green/yellow/orange/red)
- 24-bit ANSI color rendering with powerline arrow separators
- Auto-refresh every second for live clock
