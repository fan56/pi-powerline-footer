/**
 * pi-powerline-footer — Powerline-style status bar footer for pi coding agent
 *
 * Displays: cwd, git branch, provider, model + thinking level,
 * context usage (color-coded), message count, tool call count, live clock.
 *
 * Extracted from pi-ext-fan (Feature 5).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

let footerDispose: (() => void) | null = null;
let currentThinkingLevel: string = "off";

function startPowerline(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (ctx.mode !== "tui") return;

  // Get initial thinking level
  currentThinkingLevel = pi.getThinkingLevel();

  ctx.ui.setFooter((tui, _theme, footerData) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
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
      for (const e of ctx.sessionManager.getBranch()) {
        if (e.type === "message") {
          msgCount++;
          if (e.message.role === "assistant") {
            const m = e.message as AssistantMessage;
            input += m.usage?.input ?? 0;
            output += m.usage?.output ?? 0;
            for (const c of m.content ?? []) {
              if ((c as any).type === "toolCall") toolCallCount++;
            }
          }
        }
      }
      return { input, output, msgCount, toolCallCount };
    }

    // Live clock: re-render every second
    const clockTimer = setInterval(() => tui.requestRender(), 1000);

    return {
      dispose() {
        unsub();
        clearInterval(clockTimer);
      },
      invalidate() { },
      render(width: number): string[] {
        const branch = footerData.getGitBranch();
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
        const cwd = ctx.cwd.split("/").pop() || ctx.cwd;
        const segs: Segment[] = [
          { label: `📁 ${cwd}`, bgHex: "#1B5E20" },
        ];
        if (branch) {
          segs.push({ label: `⎇ ${branch}`, bgHex: "#00838F" });
        }
        if (provider) {
          segs.push({ label: `☁️ ${provider}`, bgHex: "#6A1B9A" });
        }
        segs.push({ label: `🤖 ${model} (${currentThinkingLevel})`, bgHex: "#5C6BC0" });
        segs.push({ label: `🧠 ${contextStr}`, bgHex: contextBg });
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
  footerDispose = null;
}

export default function (pi: ExtensionAPI): void {
  // Subscribe to thinking level changes once at top level
  // (fix: was previously inside startPowerline, re-registering each session_start)
  pi.on("thinking_level_select", (event) => {
    currentThinkingLevel = event.level;
  });

  pi.on("session_start", async (_event, ctx) => {
    startPowerline(ctx, pi);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPowerline();
    ctx.ui.setFooter(undefined);
  });
}
