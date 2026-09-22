/**
 * pi-powerline-footer — Powerline-style status bar footer for pi coding agent
 *
 * Top border (editor): cwd + git branch, plain border-colored text.
 * Footer: provider, model + thinking level, context usage (color-coded),
 * cache hit rate, message count, tool call count, live clock.
 * Also shows the last user request below the editor input.
 *
 * Extracted from pi-ext-fan (Features 5 & 6).
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

let footerDispose: (() => void) | null = null;
let currentThinkingLevel: string = "off";
let currentBranch: string | undefined;
let sessionGeneration = 0;

/** Whether a blocking UI prompt (select/confirm/input/editor/custom) is
 *  currently waiting on user input: the agent is paused, not working. */
let uiPromptActive = false;
let uiPromptKind: string | undefined;
let uiPromptTitle: string | undefined;
/** TUI of the active custom footer, used to re-render on prompt state changes
 *  (ui_prompt events do NOT flow through the TUI's session handleEvent, so the
 *  footer is not auto-invalidated for them). */
let footerTui: TUI | undefined;

/** Return to the "agent working" state if a UI prompt is currently pending.
 *  Guards against stuck "waiting" states when the agent resumes (new turn,
 *  tool result) without the matching ui_prompt_end ever arriving. */
function clearUiPromptIfPending(): void {
  if (!uiPromptActive) return;
  uiPromptActive = false;
  uiPromptKind = undefined;
  uiPromptTitle = undefined;
  footerTui?.requestRender();
}

/** All supported thinking levels with display config. */
const THINKING_LEVELS: Record<string, { icon: string; bg: string }> = {
  off:     { icon: "○", bg: "#616161" },
  minimal: { icon: "◔", bg: "#78909C" },
  low:     { icon: "◑", bg: "#5C6BC0" },
  medium:  { icon: "◕", bg: "#42A5F5" },
  high:    { icon: "●", bg: "#26A69A" },
  xhigh:   { icon: "◉", bg: "#FFA726" },
  max:     { icon: "★", bg: "#EF5350" },
};
function getThinkingConfig(level: string) {
  return THINKING_LEVELS[level] ?? THINKING_LEVELS.off!;
}

/** Shorten the cwd by replacing the HOME prefix with `~` (mirrors the official border-status-editor example). */
function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/** Minimal structural type for pi's border status indicators (working /
 *  compaction / branch-summary / retry spinners) — avoids importing pi's
 *  internal StatusIndicator type. */
interface BorderStatusIndicator {
  renderInBorder(width: number): string;
  renderSpinnerInBorder(width: number): string;
}

/**
 * Custom editor that replaces the input's TOP BORDER row with a plain-text
 * info line: cwd + git branch (separator: "│"), in border color only (no
 * powerline background segments). Every other row is left untouched.
 *
 * Since pi 0.86 the top border also embeds the busy status (spinner +
 * message, right-aligned) via `embedWorkingStatus: true`; widths too tight
 * for cwd + status degrade to a bare spinner, matching pi's own fallback.
 *
 * Branch re-render: the footer's onBranchChange handler already calls
 * tui.requestRender(), which re-renders this editor too, so no extra
 * editor-side requestRender is needed.
 */
class CwdBorderEditor extends CustomEditor {
  private statusIndicator: BorderStatusIndicator | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly sessionCwd: string,
  ) {
    super(tui, theme, keybindings, { paddingX: 0, embedWorkingStatus: true });
  }

  setWorkingStatusIndicator(indicator: BorderStatusIndicator | undefined): void {
    // Intentionally NOT forwarded to super: the parent's private field only
    // feeds its own embed rendering, which this class fully overrides (the
    // narrow-width fallback cannot fit a status anyway). StatusIndicator is
    // not exported from the package entry, hence the structural type.
    this.statusIndicator = indicator;
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    // Too narrow for the info line (needs 3 fixed columns: "─ " prefix + " "
    // suffix); keep the built-in border unchanged.
    if (width < 3) return super.renderTopBorder(width, hiddenLineCount);

    const parts = [`📁 ${formatCwd(this.sessionCwd)}`];
    if (currentBranch) parts.push(`⎇ ${currentBranch}`);
    // Scrolled-up lines: taken from the parameter — no need to scrape the
    // rendered border row for "↑ N" anymore.
    if (hiddenLineCount > 0) parts.push(`↑ ${hiddenLineCount}`);
    const content = parts.join(" │ ");

    // Busy status (spinner + message), self-truncating. Keep at least ~8
    // columns for the cwd segment; below that only the spinner fits.
    let status = "";
    if (this.statusIndicator) {
      status = this.statusIndicator.renderInBorder(Math.max(1, Math.floor(width * 0.4)));
      if (visibleWidth(status) > 0 && width - 5 - visibleWidth(status) < 8) {
        status = this.statusIndicator.renderSpinnerInBorder(3);
      }
    }

    const statusW = visibleWidth(status);
    // Fixed columns: "─ " + " " (3), plus " status ─" (statusW + 2) when set.
    const overhead = 3 + (statusW > 0 ? statusW + 2 : 0);
    const contentText = truncateToWidth(content, Math.max(0, width - overhead), "…");
    const fill = Math.max(0, width - overhead - visibleWidth(contentText));

    return (
      this.borderColor("─ ") +
      this.borderColor(contentText) +
      this.borderColor(" ") +
      this.borderColor("─".repeat(fill)) +
      (statusW > 0 ? " " + status + this.borderColor("─") : "")
    );
  }
}

function startPowerline(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (ctx.mode !== "tui") return;

  // Get initial thinking level
  currentThinkingLevel = pi.getThinkingLevel();

  const gen = ++sessionGeneration;

  ctx.ui.setEditorComponent(
    (tui, theme, keybindings) => new CwdBorderEditor(tui, theme, keybindings, ctx.cwd),
  );

  // Re-assert the custom editor at multiple points after session start: the
  // reload path may replace the editor AFTER our swap, so re-register several
  // times to make sure the custom editor always ends up installed. Stale
  // timers (from a superseded session) bail out via the generation check.
  const reassert = () => {
    if (gen !== sessionGeneration) return; // stale — a newer session took over
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new CwdBorderEditor(tui, theme, keybindings, ctx.cwd));
  };
  for (const delay of [150, 400, 1000, 2000]) {
    setTimeout(reassert, delay);
  }

  ctx.ui.setFooter((tui, _theme, footerData) => {
    footerTui = tui;
    currentBranch = footerData.getGitBranch() ?? undefined;
    const unsub = footerData.onBranchChange(() => {
      currentBranch = footerData.getGitBranch() ?? undefined;
      tui.requestRender();
    });
    footerDispose = unsub;

    const ARROW_RIGHT = "\uE0B0";
    const BOLD = "\x1b[1m";
    const RESET = "\x1b[0m";
    const WHITE = fg("#FFFFFF");

    interface Segment { label: string; bgHex: string; }

    function bg(hex: string): string {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `\x1b[48;2;${r};${g};${b}m`;
    }
    function fg(hex: string): string {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    function fmtNum(n: number): string {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return `${n}`;
    }
    function buildSegments(segs: Segment[]): string {
      if (!segs.length) return "";
      let out = "";
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]!;
        out += `${bg(s.bgHex)}${BOLD}${WHITE} ${s.label} `;
        if (i + 1 < segs.length) {
          out += `${bg(segs[i + 1]!.bgHex)}${fg(s.bgHex)}` + ARROW_RIGHT;
        } else {
          out += RESET;
          out += fg(s.bgHex) + ARROW_RIGHT;
        }
      }
      return out;
    }
    function getStats() {
      let input = 0, output = 0, msgCount = 0, toolCallCount = 0;
      let cacheRead = 0, cacheWrite = 0;
      let latestCacheHitRate: number | undefined;
      for (const e of ctx.sessionManager.getBranch()) {
        if (e.type === "message") {
          msgCount++;
          if (e.message.role === "assistant") {
            const m = e.message as AssistantMessage;
            const usage = m.usage;
            if (usage) {
              input += usage.input ?? 0;
              output += usage.output ?? 0;
              cacheRead += usage.cacheRead ?? 0;
              cacheWrite += usage.cacheWrite ?? 0;
              // Mirrors the built-in footer: hit rate of the LATEST assistant message that has usage.
              const latestPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
              latestCacheHitRate =
                latestPromptTokens > 0 ? ((usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
            }
            for (const c of m.content ?? []) {
              if ((c as any).type === "toolCall") toolCallCount++;
            }
          }
        }
      }
      return { input, output, msgCount, toolCallCount, cacheRead, cacheWrite, latestCacheHitRate };
    }

    // Live clock: re-render every second
    const clockTimer = setInterval(() => tui.requestRender(), 1000);

    return {
      dispose() {
        if (footerTui === tui) footerTui = undefined;
        unsub();
        clearInterval(clockTimer);
      },
      invalidate() { tui.requestRender(); },
      render(width: number): string[] {
        const branch = footerData.getGitBranch();
        currentBranch = branch ?? undefined;
        const provider = ctx.model?.provider || "";
        const model = ctx.model?.id
          ? ctx.model.id.split("/").pop()!.slice(0, 24)
          : "no-model";
        const context = ctx.getContextUsage();

        let contextStr = "";
        if (context && context.percent !== null) {
          const pct = context.percent.toFixed(1);
          contextStr = `${fmtNum(context.tokens!)}/${fmtNum(context.contextWindow)}(${pct}%)`;
        } else if (context) {
          contextStr = `?/${fmtNum(context.contextWindow)}`;
        } else {
          contextStr = "no-model";
        }

        let contextBg = "#4CAF50";
        if (context && context.percent !== null) {
          if (context.percent >= 90) contextBg = "#F44336";
          else if (context.percent >= 70) contextBg = "#FF9800";
          else if (context.percent >= 50) contextBg = "#FFC107";
        }

        const stats = getStats();
        const segs: Segment[] = [];
        if (provider) {
          segs.push({ label: `☁️ ${provider}`, bgHex: "#6A1B9A" });
        }
        const thinkCfg = getThinkingConfig(currentThinkingLevel);
        segs.push({ label: `🤖 ${model} ${thinkCfg.icon} ${currentThinkingLevel}`, bgHex: thinkCfg.bg });
        // Distinguish "agent is waiting for user input on a UI prompt" from
        // "agent is working": a distinct ⏸ segment replaces the 🧠 context
        // segment while a blocking prompt (select/confirm/input/editor/custom)
        // is pending.
        if (uiPromptActive) {
          const waitLabel = uiPromptTitle
            ? `⏸ ${truncateToWidth(uiPromptTitle.replace(/\s+/g, " ").trim(), 24, "…")}`
            : (uiPromptKind ? `⏸ ${uiPromptKind}` : "⏸ wait");
          segs.push({ label: waitLabel, bgHex: "#EF6C00" });
        } else {
          segs.push({ label: `🧠 ${contextStr}`, bgHex: contextBg });
        }
        if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined) {
          segs.push({ label: `💰 CH${stats.latestCacheHitRate.toFixed(1)}%`, bgHex: "#00796B" });
        }
        segs.push({ label: `💬 ${stats.msgCount} msgs`, bgHex: "#7B1FA2" });
        segs.push({ label: `🔧 ${stats.toolCallCount} tools`, bgHex: "#E64A19" });

        const leftStr = buildSegments(segs);
        const leftWidth = visibleWidth(leftStr);

        // Clock: right-aligned, plain text, no background
        const now = new Date();
        const clockStr = now.toLocaleTimeString('en-GB', { hour12: false });
        const clockWidth = visibleWidth(clockStr);
        const pad = Math.max(1, width - leftWidth - clockWidth);

        return [truncateToWidth(leftStr + " ".repeat(pad) + clockStr, width)];
      },
    };
  });
}

function stopPowerline(): void {
  if (footerDispose) { footerDispose(); footerDispose = null; }
}

function showLastRequest(ctx: ExtensionContext): void {
  const events = ctx.sessionManager?.getBranch?.() ?? [];
  let lastText = "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      typeof e === "object" && e !== null &&
      (e as any).type === "message" &&
      (e as any).message?.role === "user" &&
      Array.isArray((e as any).message.content)
    ) {
      const parts = (e as any).message.content.filter(
        (c: any) => c.type === "text" && c.text && c.text.trim()
      );
      if (parts.length > 0) {
        lastText = parts[0].text.trim();
      }
      break;
    }
  }
  if (lastText) {
    const display = lastText.length > 200 ? lastText.slice(0, 200) + "\u2026" : lastText;
    ctx.ui.setWidget("last-request", [" \u21b3 " + display], { placement: "belowEditor" });
  } else {
    ctx.ui.setWidget("last-request", undefined);
  }
}

export default function (pi: ExtensionAPI): void {
  // Subscribe to thinking level changes once at top level
  // (fix: was previously inside startPowerline, re-registering each session_start)
  pi.on("thinking_level_select", (event) => {
    currentThinkingLevel = event.level;
  });

  pi.on("session_start", async (event, ctx) => {
    startPowerline(ctx, pi);
    showLastRequest(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    // An agent run ending means the agent is no longer streaming; a UI prompt
    // that was pending must have resolved (the run is done). Guard against a
    // stuck "waiting" state.
    clearUiPromptIfPending();
    showLastRequest(ctx);
  });

  pi.on("tool_result", async (_event, ctx) => {
    // A tool result implies the agent resumed work; a leftover pending prompt
    // state is stale (e.g. ui_prompt_start without a matching ui_prompt_end).
    clearUiPromptIfPending();
    showLastRequest(ctx);
  });

  pi.on("agent_start", async () => {
    // A new agent run means the agent is working again; never keep the
    // "waiting for input" state across a turn boundary.
    clearUiPromptIfPending();
  });

  pi.on("ui_prompt_start", async (event) => {
    uiPromptActive = true;
    uiPromptKind = event.kind;
    uiPromptTitle = event.title;
    footerTui?.requestRender();
  });

  pi.on("ui_prompt_end", async () => {
    uiPromptActive = false;
    uiPromptKind = undefined;
    uiPromptTitle = undefined;
    footerTui?.requestRender();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Invalidate any pending re-assert timer from the outgoing session BEFORE
    // tearing the editor down, so a stale timer can't re-install it.
    sessionGeneration++;
    clearUiPromptIfPending();
    footerTui = undefined;
    stopPowerline();
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWidget("last-request", undefined);
  });
}
