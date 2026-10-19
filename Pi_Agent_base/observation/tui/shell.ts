import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createAegisTuiDataSource } from "./data-source.mjs";

type ReadCommitted = () => unknown;

function text(value: unknown, fallback = "unknown"): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function number(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function short(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function pad(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "…", false);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function stateTone(state: string): "success" | "accent" | "error" | "muted" {
	switch (state.toLowerCase()) {
		case "completed":
		case "done":
			return "success";
		case "running":
		case "ready":
			return "accent";
		case "failed":
		case "blocked":
		case "cancelled":
			return "error";
		default:
			return "muted";
	}
}

/** Large startup wordmark shown above Pi's initial empty transcript. */
export class AegisLogoHeader implements Component {
	private readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	render(width: number): string[] {
		const mark = [
			" █████╗ ███████╗ ██████╗ ██╗███████╗",
			"██╔══██╗██╔════╝██╔════╝ ██║██╔════╝",
			"███████║█████╗  ██║  ███╗██║███████╗",
			"██╔══██║██╔══╝  ██║   ██║██║╚════██║",
			"██║  ██║███████╗╚██████╔╝██║███████║",
			"╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝╚══════╝",
		];
		const subtitle = "AEGIS · work control · committed projection · read-only";
		const lines = mark.map((line) => this.theme.fg("accent", center(line, width)));
		lines.push("");
		lines.push(this.theme.fg("muted", center(subtitle, width)));
		lines.push("");
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

function center(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "…", false);
	const padding = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2));
	return " ".repeat(padding) + clipped;
}

/** One-line label above Pi's native editor: keeps the composer identity visible. */
export class AegisComposerBar implements Component {
	private readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	render(width: number): string[] {
		const line = [
			this.theme.fg("accent", "▌ INPUT"),
			this.theme.fg("text", "Enter 发送"),
			this.theme.fg("dim", "·"),
			this.theme.fg("muted", "F7/F8/F9 面板"),
			this.theme.fg("dim", "·"),
			this.theme.fg("muted", "状态只读"),
		].join("  ");
		return [this.theme.bg("toolPendingBg", pad(line, width))];
	}

	invalidate(): void {}
	dispose(): void {}
}

/** One-line Aegis status bar pinned above Pi's native transcript. */
export class AegisTopBar implements Component {
	private readonly theme: Theme;
	private readonly source: ReturnType<typeof createAegisTuiDataSource>;

	constructor(_tui: TUI, theme: Theme, readCommitted: ReadCommitted) {
		this.theme = theme;
		this.source = createAegisTuiDataSource(readCommitted);
	}

	render(width: number): string[] {
		let line: string;
		try {
			const snapshot = this.source.snapshot() as Record<string, any>;
			const current = snapshot.current ?? {};
			const integrity = snapshot.integrity ?? {};
			const budgets = snapshot.budgets ?? {};
			const state = text(current.state, "unknown");
			const status =
				integrity.ok === true
					? "COMMITTED"
					: integrity.status === "manifest_unavailable"
						? "NO MANIFEST"
						: "UNAVAILABLE";
			line = [
				this.theme.style("◆ AEGIS", { fg: "accent", bold: true }),
				`${this.theme.fg("dim", "task ")}${this.theme.fg("text", text(current.taskId))}`,
				this.theme.style(` ${state.toUpperCase()} `, { fg: stateTone(state), bold: true }),
				`${this.theme.fg("dim", "pending ")}${this.theme.fg("text", String(snapshot.pending?.length ?? 0))}`,
				`${this.theme.fg("dim", "budget ")}${this.theme.fg("text", `${number(budgets.consumed?.tool_calls)}/${number(budgets.reserved?.task)}/${number(budgets.unresolved)}`)}`,
				`${this.theme.fg("dim", "rev ")}${this.theme.fg("text", short(text(snapshot.revision), 18))}`,
				this.theme.style(` ${status} `, { fg: integrity.ok === true ? "success" : "error", bold: true }),
				snapshot.campaign?.id
					? `${this.theme.fg("dim", "campaign ")}${this.theme.fg("text", short(text(snapshot.campaign.id), 30))}`
					: "",
			]
				.filter(Boolean)
				.join(this.theme.fg("dim", " │ "));
		} catch (error) {
			line = `${this.theme.fg("error", "AEGIS UNAVAILABLE")}  ${this.theme.fg("muted", error instanceof Error ? error.message : String(error))}`;
		}
		return [this.theme.bg("toolPendingBg", pad(line, width))];
	}

	invalidate(): void {}
	dispose(): void {}
}

/** Persistent context sidebar shown beside Pi's transcript at >=100 columns. */
export class AegisSidebar implements Component {
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly source: ReturnType<typeof createAegisTuiDataSource>;

	constructor(tui: TUI, theme: Theme, readCommitted: ReadCommitted) {
		this.theme = theme;
		this.tui = tui;
		this.source = createAegisTuiDataSource(readCommitted);
	}

	render(width: number): string[] {
		const inner = Math.max(8, width - 2);
		const lines: string[] = [];
		try {
			const snapshot = this.source.snapshot() as Record<string, any>;
			const current = snapshot.current ?? {};
			const integrity = snapshot.integrity ?? {};
			const counts = snapshot.counts?.board ?? {};
			const steps = this.source.evidence().steps ?? [];
			lines.push(this.head("CONTEXT", "read-only"));
			lines.push(this.compose("task", text(current.taskId)));
			lines.push(
				`${this.theme.fg("dim", "state      ")}${this.theme.style(` ${text(current.state).toUpperCase()} `, {
					fg: stateTone(text(current.state)),
					bold: true,
				})}`,
			);
			lines.push(this.compose("episode", short(text(current.episodeId), 18)));
			lines.push(this.compose("pending", String(snapshot.pending?.length ?? 0)));
			lines.push(this.compose("unresolved", number(snapshot.budgets?.unresolved)));
			lines.push("");
			lines.push(this.head("INSPECT"));
			if (integrity.ok !== true) {
				lines.push(this.theme.fg("error", integrity.status === "manifest_unavailable" ? "NO MANIFEST" : "UNAVAILABLE"));
				lines.push(this.theme.fg("muted", "set AEGIS_MANIFEST_FILE"));
			}
			lines.push(this.theme.fg("accent", "F7/F8/F9 检查器"));
			lines.push(this.theme.fg("muted", "Esc stays in chat"));
			lines.push("");
			lines.push(this.head("BOARD"));
			lines.push(this.compose("judged", String((counts.Fact?.current ?? 0) + (counts.Refuted?.current ?? 0))));
			lines.push(this.compose("observed", String((counts.Artifact?.current ?? 0) + (counts.Origin?.current ?? 0))));
			lines.push(this.compose("hint/intent", String((counts.Hint?.current ?? 0) + (counts.Intent?.current ?? 0))));
			lines.push("");
			lines.push(this.head("LADDER"));
			for (const step of steps) {
				const tone = step.status === "DONE" ? "success" : step.status === "PARTIAL" ? "warning" : "muted";
				lines.push(
					`${this.theme.fg(tone, `[${text(step.status)}]`)} ${this.theme.fg("muted", short(text(step.label), inner - 10))}`,
				);
			}
			const recent = snapshot.recent ?? [];
			if (recent.length > 0) {
				lines.push("");
				lines.push(this.head("RECENT"));
				for (const event of recent.slice(0, 5)) {
					lines.push(this.theme.fg("text", short(text(event.event_type), inner)));
				}
			}
			lines.push("");
			lines.push(this.head("TRUST"));
			lines.push(this.theme.fg("muted", "transport ≠ passed"));
			lines.push(this.theme.fg("muted", "claim ≠ fact"));
			lines.push(this.theme.fg("muted", "fact ≠ outcome"));
		} catch (error) {
			lines.push(this.theme.fg("error", "AEGIS UNAVAILABLE"));
			lines.push(this.theme.fg("muted", error instanceof Error ? error.message : String(error)));
		}
		const target = Math.max(8, Math.floor(this.tui.terminal.rows - 6));
		const clipped = lines.slice(0, target);
		while (clipped.length < target) clipped.push("");
		return clipped.map((line) => this.theme.bg("toolPendingBg", this.frame(line, inner)));
	}

	private frame(line: string, inner: number): string {
		return `${this.theme.fg("borderMuted", "│")} ${pad(line, inner)}`;
	}

	private head(title: string, meta = ""): string {
		const left = this.theme.fg("accent", `▌ ${title}`);
		return meta ? this.compose(left, this.theme.fg("dim", meta)) : left;
	}

	private compose(left: string, right: string): string {
		const width = 30;
		const rightWidth = visibleWidth(right);
		const leftWidth = Math.max(0, width - rightWidth - 1);
		return `${this.theme.fg("muted", truncateToWidth(left, leftWidth, "…", false))}${" ".repeat(Math.max(1, width - leftWidth - rightWidth))}${this.theme.fg("text", right)}`;
	}

	invalidate(): void {}
	dispose(): void {}
}
