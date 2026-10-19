import type { ExtensionContext, KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type Keybindings,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createAegisTuiDataSource } from "./data-source.mjs";

type Tab = "graph" | "board" | "evidence";
type Tone = "accent" | "success" | "warning" | "error" | "proposal" | "artifact" | "muted";

type Snapshot = {
	revision: string;
	integrity: { ok: boolean; status: string };
	campaign: {
		id: string | null;
		control: string;
		manifestRevision?: string | number | null;
		title?: string | null;
		objective?: string | null;
		criteria?: string[];
	};
	current: {
		taskId: string | null;
		state: string | null;
		episodeId: string | null;
		sessionId: string | null;
	};
	budgets: {
		consumed: Record<string, number | null>;
		reserved: Record<string, number | null>;
		unresolved: number | null;
	};
	counts: {
		tasks: Record<string, number>;
		board: Record<string, { current: number; history: number }>;
	};
	pending: Array<{
		id: string;
		kind: string;
		status: string;
		reason: string | null;
		taskId: string | null;
	}>;
	health: { stale: boolean; truncated: boolean; warnings: string[] };
	recent: Array<{
		event_id: string | null;
		event_type: string | null;
		episode_id: string | null;
		source_kind: string | null;
		sequence: number | null;
		occurred_at: string | null;
	}>;
};

type Page<T> = {
	revision: string;
	items: T[];
	total: number;
	returned: number;
	offset: number;
	limit: number;
	truncated: boolean;
	nextCursor: string | null;
	previousCursor: string | null;
	edges?: Array<Record<string, unknown>>;
};

type Detail = {
	status: string;
	value?: Record<string, unknown>;
	reason?: string;
	revision?: string;
};
type DataSource = ReturnType<typeof createAegisTuiDataSource>;

type ItemKind = "task" | "board-node" | "pending";
type Item = { kind: ItemKind; id: string; row: Record<string, unknown> };

const REFRESH_ACTION = "app.aegis.inspect.refresh" as keyof Keybindings;
const TABS: Tab[] = ["graph", "board", "evidence"];
const TAB_LABELS: Record<Tab, string> = {
	graph: "Graph",
	board: "Board",
	evidence: "Evidence",
};
const BOARD_GROUP: Record<string, string> = {
	Fact: "JUDGED",
	Refuted: "JUDGED",
	Hint: "PROPOSALS",
	Intent: "PROPOSALS",
	Artifact: "OBSERVED",
	Origin: "OBSERVED",
	Pending: "PENDING",
};
const TONES: Record<Tone, ThemeColor> = {
	accent: "accent",
	success: "success",
	warning: "warning",
	error: "error",
	proposal: "customMessageLabel",
	artifact: "mdLink",
	muted: "muted",
};

function text(value: unknown, fallback = "unknown"): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberText(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function shortRevision(value: string): string {
	return value.length > 18 ? `${value.slice(0, 18)}…` : value;
}

function shortValue(value: string | null, max = 22): string {
	if (!value) return "unknown";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Flatten a UI value without ever using an unbounded JSON dump. */
function displayValue(value: unknown, max = 240): string {
	if (value === null || value === undefined) return "unknown";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "none";
		const values = value.slice(0, 6).map((entry) => displayValue(entry, 80));
		return values.join(", ") + (value.length > values.length ? ` +${value.length - values.length}` : "");
	}
	try {
		const encoded = JSON.stringify(value);
		return encoded.length > max ? `${encoded.slice(0, max - 1)}…` : encoded;
	} catch {
		return "unserializable";
	}
}

function stateTone(state: string): Tone {
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

function evidenceTone(status: string): Tone {
	switch (status) {
		case "DONE":
			return "success";
		case "PARTIAL":
			return "warning";
		case "UNKNOWN":
			return "muted";
		default:
			return "muted";
	}
}

function boardTrust(row: Record<string, unknown>): {
	label: string;
	tone: Tone;
} {
	switch (row.type) {
		case "Fact":
			return { label: "VERIFIED", tone: "success" };
		case "Refuted":
			return { label: "VERIFIED", tone: "warning" };
		case "Hint":
		case "Intent":
			return { label: "UNVERIFIED", tone: "proposal" };
		case "Artifact":
			return { label: "OBSERVED", tone: "artifact" };
		case "Origin":
			return { label: "ORIGIN", tone: "muted" };
		default:
			return {
				label: text(row.effective_status, "UNKNOWN").toUpperCase(),
				tone: "muted",
			};
	}
}

function boardTone(row: Record<string, unknown>): Tone {
	switch (row.type) {
		case "Fact":
			return "success";
		case "Refuted":
			return "warning";
		case "Hint":
		case "Intent":
			return "proposal";
		case "Artifact":
			return "artifact";
		default:
			return "muted";
	}
}

/**
 * A full-screen, read-only Aegis Inspector.
 *
 * This component deliberately does not own the chat or the editor. It is opened as a
 * Pi overlay and returns to the existing editor on Esc. All data comes from the
 * committed-projection data source passed by the extension command.
 */
export class AegisInspector implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly source: DataSource;
	private readonly done: () => void;

	private tab: Tab = "graph";
	private snapshot: Snapshot | null = null;
	private page: Page<Record<string, unknown>> | null = null;
	private items: Item[] = [];
	private selected = 0;
	private cursor: string | null = null;
	private detail: Detail | null = null;
	private evidence: { steps?: Record<string, unknown>[] } | null = null;
	private detailKind: ItemKind | null = null;
	private detailId: string | null = null;
	private showDetail = false;
	private error: string | null = null;
	private revision = "";
	private hitRows: Array<{ start: number; end: number; index: number }> = [];
	private masterHitWidth = 0;
	private lastWidth = 80;
	private disposed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		source: DataSource,
		done: () => void,
		initialTab: Tab = "graph",
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.source = source;
		this.done = done;
		this.tab = initialTab;
		this.load();
	}

	/* ------------------------------------------------------------------ data */

	private load(resetCursor = false): void {
		if (this.disposed) return;
		if (resetCursor) this.cursor = null;
		try {
			const next = asRecord(this.source.snapshot()) as unknown as Snapshot;
			const nextRevision = text(next?.revision, "");
			if (this.revision && nextRevision && this.revision !== nextRevision) {
				this.cursor = null;
				this.selected = 0;
				this.detail = null;
				this.detailKind = null;
				this.detailId = null;
				this.showDetail = false;
			}
			this.snapshot = next;
			this.revision = nextRevision;
			this.error = null;
			this.page = null;
			this.items = [];

			this.evidence = (this.source.evidence?.() as { steps?: Record<string, unknown>[] }) ?? null;
			if (this.tab === "evidence") {
				// Evidence is derived from the same committed source, not a local fixture.
				const steps = Array.isArray(this.evidence?.steps) ? this.evidence.steps : [];
				this.page = {
					revision: this.revision,
					items: steps,
					total: steps.length,
					returned: steps.length,
					offset: 0,
					limit: 4,
					truncated: false,
					nextCursor: null,
					previousCursor: null,
				};
			} else if (this.tab === "graph") {
				this.page = this.source.taskPage({
					revision: this.revision,
					cursor: this.cursor,
				}) as Page<Record<string, unknown>>;
				this.items = (this.page?.items ?? []).map((row) => ({
					kind: "task" as const,
					id: text(row.task_id, "unknown"),
					row,
				}));
			} else {
				this.page = this.source.boardPage({
					revision: this.revision,
					cursor: this.cursor,
					scope: "current",
				}) as Page<Record<string, unknown>>;
				this.items = (this.page?.items ?? []).map((row) => ({
					kind: "board-node" as const,
					id: text(row.node_id, "unknown"),
					row,
				}));
				const groupRank = (item: Item) => {
					const group = BOARD_GROUP[text(item.row.type, "Pending")] ?? "OBSERVED";
					return ["JUDGED", "PROPOSALS", "OBSERVED", "PENDING"].indexOf(group);
				};
				this.items.sort((left, right) => groupRank(left) - groupRank(right));
				for (const pending of this.snapshot?.pending ?? []) {
					this.items.push({
						kind: "pending",
						id: pending.id,
						row: pending as unknown as Record<string, unknown>,
					});
				}
			}

			this.selected = Math.max(0, Math.min(this.selected, Math.max(0, this.items.length - 1)));
			if (this.tab !== "evidence") this.loadDetail();
			else this.detail = null;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.page = null;
			this.items = [];
			this.detail = null;
		}
		this.tui.requestRender();
	}

	private loadDetail(): void {
		const item = this.items[this.selected];
		if (!item) {
			this.detail = null;
			this.detailKind = null;
			this.detailId = null;
			return;
		}
		this.detailKind = item.kind;
		this.detailId = item.id;
		if (item.kind === "pending") {
			this.detail = {
				status: "available",
				revision: this.revision,
				value: {
					id: item.row.id,
					kind: item.row.kind,
					status: item.row.status,
					reason: item.row.reason,
					task_id: item.row.taskId,
					note: "待处理责任没有最终 Outcome；该界面不提供提交或确认操作。",
				},
			};
			return;
		}
		try {
			this.detail = this.source.detail({
				kind: item.kind,
				id: item.id,
				revision: this.revision,
			}) as Detail;
		} catch (error) {
			this.detail = {
				status: "unavailable",
				revision: this.revision,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private setTab(tab: Tab): void {
		if (this.tab === tab) return;
		this.tab = tab;
		this.cursor = null;
		this.selected = 0;
		this.detail = null;
		this.detailKind = null;
		this.detailId = null;
		this.showDetail = false;
		this.load();
	}

	private move(delta: number): void {
		if (this.items.length === 0) return;
		this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
		if (this.tab !== "evidence") this.loadDetail();
		this.tui.requestRender();
	}

	private openDetail(): void {
		if (this.items.length === 0) return;
		if (!this.detail) this.loadDetail();
		this.showDetail = true;
		this.tui.requestRender();
	}

	private back(): void {
		if (this.showDetail) {
			this.showDetail = false;
			this.tui.requestRender();
		}
	}

	/* --------------------------------------------------------------- input */

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.ctrl("1")) || data === "1") {
			this.setTab("graph");
			return;
		}
		if (matchesKey(data, Key.ctrl("2")) || data === "2") {
			this.setTab("board");
			return;
		}
		if (matchesKey(data, Key.ctrl("3")) || data === "3") {
			this.setTab("evidence");
			return;
		}
		if (this.isRefreshKey(data)) {
			this.selected = 0;
			this.detail = null;
			this.showDetail = false;
			this.load(true);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openDetail();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.back();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			if (this.page?.nextCursor) {
				this.cursor = this.page.nextCursor;
				this.selected = 0;
				this.detail = null;
				this.showDetail = false;
				this.load();
			}
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			if (this.page?.previousCursor) {
				this.cursor = this.page.previousCursor;
				this.selected = 0;
				this.detail = null;
				this.showDetail = false;
				this.load();
			}
		}
	}

	private isRefreshKey(data: string): boolean {
		try {
			return this.keybindings.matches(data, REFRESH_ACTION) || matchesKey(data, Key.f5);
		} catch {
			return matchesKey(data, Key.f5);
		}
	}

	/* -------------------------------------------------------------- styling */

	private fg(tone: Tone, value: string): string {
		return this.theme.fg(TONES[tone], value);
	}

	private plainBadge(label: string, tone: Tone): string {
		return this.fg(tone, `[${label}]`);
	}

	private dim(value: string): string {
		return this.theme.fg("dim", value);
	}

	private muted(value: string): string {
		return this.theme.fg("muted", value);
	}

	private border(value: string): string {
		return this.theme.fg("border", value);
	}

	private borderMuted(value: string): string {
		return this.theme.fg("borderMuted", value);
	}

	private fit(value: string, width: number): string {
		return truncateToWidth(value, Math.max(0, width), "…", false);
	}

	private fill(value: string, width: number): string {
		return truncateToWidth(value, Math.max(0, width), "…", true);
	}

	private compose(left: string, right: string, width: number): string {
		if (width <= 0) return "";
		const rightWidth = visibleWidth(right);
		if (rightWidth >= width) return this.fit(right, width);
		const leftWidth = Math.max(0, width - rightWidth - 1);
		const clippedLeft = this.fit(left, leftWidth);
		const gap = Math.max(1, width - visibleWidth(clippedLeft) - rightWidth);
		return clippedLeft + " ".repeat(gap) + right;
	}

	private rule(width: number, left = "├", right = "┤"): string {
		return this.border(left + "─".repeat(Math.max(0, width - 2)) + right);
	}

	private topLine(content: string, width: number): string {
		const inner = Math.max(0, width - 2);
		const contentWidth = Math.max(0, inner - 4);
		const clipped = this.fit(content, contentWidth);
		const remaining = Math.max(0, contentWidth - visibleWidth(clipped));
		return this.border("╭─ ") + clipped + this.border(` ${"─".repeat(remaining)} ╮`);
	}

	private bodyLine(content: string, width: number): string {
		const inner = Math.max(0, width - 2);
		return this.border("│") + this.fill(content, inner) + this.border("│");
	}

	private footerLine(content: string, width: number): string {
		const inner = Math.max(0, width - 4);
		return this.border("│ ") + this.fill(content, inner) + this.border(" │");
	}

	/* -------------------------------------------------------------- header */

	private summary(): string {
		const snapshot = this.snapshot;
		const current = snapshot?.current;
		const task = text(current?.taskId, "unknown");
		const state = text(current?.state, "unknown");
		const pending = snapshot?.pending?.length ?? null;
		const consumed = snapshot?.budgets?.consumed?.tool_calls;
		const reserved = snapshot?.budgets?.reserved?.task;
		const unresolved = snapshot?.budgets?.unresolved;
		const revision = shortRevision(text(snapshot?.revision, "unknown"));
		const integrityStatus = text(snapshot?.integrity?.status, "unavailable");
		const integrity =
			snapshot?.integrity?.ok === true
				? "COMMITTED"
				: integrityStatus === "manifest_unavailable"
					? "NO MANIFEST"
					: "UNAVAILABLE";
		const fields = [
			`${this.dim("task ")}${this.theme.fg("text", task)} ${this.plainBadge(state.toUpperCase(), stateTone(state))}`,
			`${this.dim("pending ")}${this.theme.fg(pending === null ? "muted" : "text", pending === null ? "unknown" : String(pending))}`,
			`${this.dim("budget ")}${this.theme.fg("text", `${numberText(consumed)}/${numberText(reserved)}/${numberText(unresolved)}`)}`,
			`${this.dim("rev ")}${this.theme.fg("text", revision)}`,
			this.plainBadge(integrity, snapshot?.integrity?.ok === true ? "success" : "error"),
		];
		if (snapshot?.campaign?.id) {
			fields.push(`${this.dim("campaign ")}${this.theme.fg("text", shortValue(snapshot.campaign.id, 28))}`);
		}
		return [this.theme.style("◆ AEGIS INSPECT · F6", { fg: "accent", bold: true }), ...fields].join("  ");
	}

	private headerLines(width: number): string[] {
		const tab = this.tab;
		const selected = this.items[this.selected]?.id;
		const crumbs = [
			this.muted("INSPECT / "),
			this.theme.fg("text", TAB_LABELS[tab]),
			selected ? this.dim(" / ") : "",
			selected ? this.theme.fg("text", selected) : "",
		].join("");
		const tabs = TABS.map((candidate, index) => {
			const label = `[${index + 1}] ${TAB_LABELS[candidate]}`;
			if (candidate === tab)
				return this.theme.style(label, {
					fg: "accent",
					bg: "selectedBg",
					bold: true,
				});
			return this.muted(label);
		}).join("  ");
		const tabLine = this.compose(`${tabs}   ${crumbs}`, this.muted("Esc 返回对话输入 · F7/F8/F9 面板"), Math.max(0, width - 4));
		return [
			this.topLine(this.summary(), width),
			this.border("│ ") + this.fill(tabLine, Math.max(0, width - 4)) + this.border(" │"),
			this.rule(width),
		];
	}

	/* --------------------------------------------------------------- body */

	render(width: number): string[] {
		const safeWidth = Math.max(24, Math.floor(width || 80));
		this.lastWidth = safeWidth;
		this.hitRows = [];
		const rows = Math.max(12, Math.floor(this.tui.terminal?.rows || 24));
		const bodyHeight = Math.max(4, rows - 6);
		const inner = safeWidth - 2;
		const body = this.buildBody(safeWidth, bodyHeight);

		while (body.length < bodyHeight) body.push(this.dim(""));
		const clippedBody = body.slice(0, bodyHeight).map((line) => this.bodyLine(line, safeWidth));
		const focus = this.showDetail && safeWidth < 100 ? "DETAIL" : "MASTER";
		const help = this.muted(
			`FOCUS ${focus}  1 Graph · 2 Board · 3 Evidence · ↑↓ select · Enter detail · PgUp/PgDn · F5 refresh · Esc 返回`,
		);
		const meta = this.dim(`read-only · rev ${shortRevision(text(this.revision, "unknown"))} · ${safeWidth}×${rows}`);
		const footer = this.compose(help, meta, Math.max(0, inner - 4));

		return [
			...this.headerLines(safeWidth),
			...clippedBody,
			this.rule(safeWidth),
			this.footerLine(footer, safeWidth),
			this.border(`╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`),
		];
	}

	private buildBody(width: number, height: number): string[] {
		const inner = Math.max(1, width - 2);
		const eventHeight = height >= 28 ? Math.min(9, Math.max(4, Math.floor(height / 6))) : 0;
		const mainHeight = height - (eventHeight > 0 ? eventHeight + 1 : 0);
		const main = this.buildMain(width, mainHeight);
		if (eventHeight <= 0) return main;
		const events = this.eventLines(inner, eventHeight);
		return [...main, ...events].slice(0, height);
	}

	private buildMain(width: number, height: number): string[] {
		const inner = Math.max(1, width - 2);
		if (this.error) return this.errorLines(inner);
		if (this.tab === "evidence") return this.evidenceLines(inner, height);
		if (width >= 120) return this.splitLines(inner, height, true);
		if (width >= 100) return this.splitLines(inner, height, false);
		return this.showDetail ? this.detailLines(inner, height) : this.masterLines(inner, height);
	}

	private eventLines(width: number, height: number): string[] {
		const lines = [this.section(" EVENT LOG · committed ", width)];
		const recent = this.snapshot?.recent ?? [];
		if (this.snapshot?.integrity.ok !== true) {
			lines.push(this.fg("error", "EVENT LOG UNAVAILABLE · committed stream not authoritative"));
			for (const warning of (this.snapshot?.health?.warnings ?? []).slice(0, 2)) {
				lines.push(...this.wrapped(`reason: ${warning}`, width, 0, "muted"));
			}
			lines.push(this.dim("Esc 返回对话输入 · F5 重试"));
			return this.fitList(lines, height, width);
		}
		if (recent.length === 0) lines.push(this.muted("no committed events in this revision"));
		for (const event of recent) {
			const type = text(event.event_type, "event");
			const episode = text(event.episode_id, "—");
			const source = text(event.source_kind, "unknown");
			const sequence = typeof event.sequence === "number" ? ` #${event.sequence}` : "";
			lines.push(
				this.compose(
					`${this.theme.fg("text", type)} ${this.dim(`ep:${episode}`)}`,
					this.dim(`source:${source}${sequence}`),
					width,
				),
			);
		}
		return this.fitList(lines, height, width);
	}

	private errorLines(width: number): string[] {
		const warnings = this.snapshot?.health?.warnings ?? [];
		return [
			this.fg("error", "READ ERROR · committed projection unavailable"),
			...wrapTextWithAnsi(this.error ?? "unknown error", width).map((line) => this.theme.fg("error", line)),
			...warnings
				.slice(0, 2)
				.flatMap((warning) => wrapTextWithAnsi(`reason: ${warning}`, width).map((line) => this.dim(line))),
			this.dim("Esc 返回对话输入 · F5 重试 · 不写入任何状态"),
		];
	}

	private splitLines(width: number, height: number, withAside: boolean): string[] {
		const masterWidth = width >= 158 ? 48 : 40;
		const asideWidth = withAside ? 32 : 0;
		const separators = withAside ? 2 : 1;
		const detailWidth = Math.max(12, width - masterWidth - asideWidth - separators);
		const master = this.masterLines(masterWidth, height);
		const detail = this.detailLines(detailWidth, height);
		const aside = withAside ? this.asideLines(asideWidth, height) : [];
		const lines: string[] = [];
		for (let index = 0; index < height; index++) {
			let line = this.fill(master[index] ?? "", masterWidth) + this.borderMuted("│");
			line += this.fill(detail[index] ?? "", detailWidth);
			if (withAside) line += this.borderMuted("│") + this.fill(aside[index] ?? "", asideWidth);
			lines.push(line);
		}
		return lines;
	}

	private masterLines(width: number, height: number): string[] {
		const lines: string[] = [];
		this.masterHitWidth = width;
		const selected = this.selected;
		let lastGroup = "";

		if (this.snapshot && this.snapshot.integrity.ok !== true) {
			const status = text(this.snapshot.integrity.status, "unavailable");
			lines.push(
				this.fg(
					"error",
					status === "manifest_unavailable"
						? "NO CAMPAIGN MANIFEST · set AEGIS_MANIFEST_FILE (or AEGIS_CAMPAIGN_MANIFEST)"
						: "INTEGRITY UNAVAILABLE · rows are not authoritative",
				),
			);
			for (const warning of (this.snapshot.health.warnings ?? []).slice(0, 2)) {
				lines.push(...this.wrapped(`reason: ${warning}`, width, 0, "muted"));
			}
		}

		if (this.items.length === 0) {
			lines.push(this.muted("当前 revision 没有可显示条目。"));
			lines.push(this.fg("accent", "Esc 返回对话输入；配置 Campaign Manifest 后按 F5。"));
			return this.fitList(lines, height, width);
		}

		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index];
			if (!item) continue;
			const row = item.row;
			if (this.tab === "board") {
				const group = BOARD_GROUP[text(row.type, "Pending")] ?? "OBSERVED";
				if (group !== lastGroup) {
					lines.push(this.section(` ${group} `, width));
					lastGroup = group;
				}
			}
			const itemStart = lines.length;
			const linesForItem = this.itemLines(item, width, index === selected);
			lines.push(...linesForItem);
			this.hitRows.push({
				start: 3 + itemStart,
				end: 3 + lines.length - 1,
				index,
			});
		}

		if (this.page) {
			const end = this.page.offset + this.page.returned;
			const extra = Math.max(0, this.items.length - (this.page.items?.length ?? 0));
			const pager = `${this.page.total === 0 ? "0" : `${this.page.offset + 1}–${end}`}/${this.page.total}${extra > 0 ? ` +${extra} pending` : ""}`;
			const hints = `${this.page.previousCursor ? "PgUp " : ""}${this.page.nextCursor ? "PgDn" : ""}`.trim();
			lines.push(this.dim(`${pager}${hints ? `  ${hints}` : ""}${this.page.truncated ? "  truncated" : ""}`));
		}
		if (this.tab === "graph") {
			const edges = this.page?.edges ?? [];
			if (edges.length > 0) {
				lines.push(this.section(" DEPENDS ", width));
				for (const edge of edges.slice(0, 4)) {
					const from = displayValue(edge.from, 30).replace(/^task:/, "");
					const to = displayValue(edge.to, 30).replace(/^task:/, "");
					const relation = text(edge.relation, "edge");
					lines.push(this.fill(`  ${from} → ${to}  ${this.dim(relation)}`, width));
				}
			}
		}
		const campaign = this.snapshot?.campaign;
		if (campaign?.objective) {
			lines.push(this.section(" CAMPAIGN ", width));
			lines.push(...this.wrapped(campaign.objective, width, 2));
			for (const criterion of (campaign.criteria ?? []).slice(0, 3)) {
				lines.push(...this.wrapped(`• ${criterion}`, width, 2));
			}
		}
		const taskCounts = this.snapshot?.counts?.tasks ?? {};
		const countText = Object.entries(taskCounts)
			.map(([state, count]) => `${state} ${count}`)
			.join(" · ");
		if (countText) {
			lines.push(this.section(" TASK STATES ", width));
			lines.push(...this.wrapped(countText, width, 2));
		}
		const steps = this.evidence?.steps ?? [];
		if (steps.length > 0) {
			lines.push(this.section(" LADDER ", width));
			for (const step of steps) {
				const status = text(step.status, "UNKNOWN");
				lines.push(
					`  ${this.plainBadge(status, evidenceTone(status))} ${this.fill(text(step.label, "STEP"), Math.max(4, width - 12))}`,
				);
			}
		}
		return this.fitList(lines, height, width);
	}

	private fitList(lines: string[], height: number, width: number): string[] {
		const result = lines.slice(0, height).map((line) => this.fill(line, width));
		if (lines.length > height && height > 0) result[height - 1] = this.fill(`${this.dim("…")}`, width);
		return result;
	}

	private section(title: string, width: number): string {
		const label = this.muted(title);
		const used = visibleWidth(label);
		return label + this.borderMuted(" " + "─".repeat(Math.max(0, width - used - 1)));
	}

	private itemLines(item: Item, width: number, selected: boolean): string[] {
		const row = item.row;
		const marker = selected ? this.fg("accent", "▌") : " ";
		let first: string;
		let second: string;

		if (item.kind === "pending") {
			first = `${marker}${this.fg("warning", "Pending")} ${this.plainBadge(text(row.status, "UNKNOWN"), "warning")} ${this.dim(item.id)}`;
			second = `  ${this.theme.fg("text", text(row.reason, text(row.kind, "waiting")))}`;
		} else if (this.tab === "graph") {
			const state = text(row.state, "unknown");
			const id = text(row.task_id, "unknown");
			const goal = text(row.goal, "(no goal declared)");
			const parent = row.parent_task_id ? this.dim(` parent:${displayValue(row.parent_task_id, 40)}`) : "";
			first = `${marker}${this.theme.fg("text", id)} ${this.plainBadge(state.toUpperCase(), stateTone(state))}${parent}`;
			second = `  ${this.theme.fg("muted", goal)}`;
		} else {
			const type = text(row.type, "unknown");
			const trust = boardTrust(row);
			const effective = text(row.effective_status, "current");
			const status = effective === "current" ? "" : ` ${this.plainBadge(effective.toUpperCase(), "warning")}`;
			first = `${marker}${this.fg(boardTone(row), type)} ${this.plainBadge(trust.label, trust.tone)}${status} ${this.dim(text(row.node_id, "unknown"))}`;
			second = `  ${this.theme.fg("text", displayValue(row.text, 160))}`;
		}

		const styled = [this.fill(first, width), this.fill(second, width)];
		return selected ? styled.map((line) => this.theme.bg("selectedBg", line)) : styled;
	}

	private detailLines(width: number, height: number): string[] {
		const lines: string[] = [];
		if (this.showDetail && width < 100) lines.push(this.fg("accent", "← Backspace 返回列表"));
		if (!this.detail) {
			lines.push(this.muted("Enter 打开当前选中项详情。"));
			return lines;
		}
		if (this.detail.status !== "available") {
			lines.push(this.fg("error", "详情不可用"));
			lines.push(
				...wrapTextWithAnsi(text(this.detail.reason, "unknown reason"), width).map((line) => this.muted(line)),
			);
			return lines;
		}
		const value = this.detail.value ?? {};
		if (this.detailKind === "pending") {
			lines.push(
				this.theme.style(`Pending ${text(value.id, this.detailId)}`, {
					fg: "warning",
					bold: true,
				}),
			);
			lines.push(this.muted("待处理责任 · 只读"));
			lines.push("");
			lines.push(...this.field("kind", value.kind, width));
			lines.push(...this.field("status", value.status, width));
			lines.push(...this.field("task", value.task_id, width));
			lines.push(...this.field("reason", value.reason, width));
			lines.push("");
			lines.push(...wrapTextWithAnsi(text(value.note), width).map((line) => this.muted(line)));
			return this.trimDetail(lines, height, width);
		}
		if (this.detailKind === "task") {
			lines.push(
				`${this.theme.style(text(value.task_id, this.detailId), { fg: "accent", bold: true })} ${this.plainBadge(text(value.state, "unknown").toUpperCase(), stateTone(text(value.state, "unknown")))}`,
			);
			lines.push(this.muted(text(value.goal, "(no goal declared)")));
			lines.push("");
			lines.push(this.section(" TASK ", width));
			lines.push(...this.field("state", value.state, width));
			lines.push(...this.field("lifecycle", value.lifecycle_state, width));
			lines.push(...this.field("parent", value.parent_task_id ?? "root", width));
			lines.push(...this.field("depends_on", value.depends_on, width));
			lines.push(...this.field("dynamic", value.is_dynamic === true ? "true" : "false", width));
			lines.push(...this.field("episode", value.episode_id, width));
			lines.push(...this.field("plan", value.plan_id, width));
			lines.push("");
			lines.push(this.section(" CRITERIA ", width));
			const criteria = Array.isArray(value.success_criteria) ? value.success_criteria : [];
			if (criteria.length === 0) lines.push(this.muted("no criterion declared"));
			for (const criterion of criteria) lines.push(...this.wrapped(`• ${displayValue(criterion, 240)}`, width, 0));
			lines.push("");
			lines.push(this.section(" EVIDENCE / OUTCOME ", width));
			lines.push(...this.field("evidence", value.evidence_status, width));
			lines.push(...this.field("outcome", value.outcome_ref ?? "none", width));
			lines.push(...this.field("stop", value.stop_reason ?? "—", width));
			lines.push(...this.field("blocked", value.blocked_reason ?? "—", width));
			const incident = asRecord(value.incident_edges);
			if (incident) {
				const outgoing = Array.isArray(incident.outgoing) ? incident.outgoing.length : 0;
				const incoming = Array.isArray(incident.incoming) ? incident.incoming.length : 0;
				lines.push(...this.field("edges", `out ${outgoing} · in ${incoming}`, width));
			}
			return this.trimDetail(lines, height, width);
		}

		// Board node detail.
		const type = text(value.type, "unknown");
		const trust = boardTrust(value);
		lines.push(
			`${this.fg(boardTone(value), type)} ${this.plainBadge(trust.label, trust.tone)} ${this.theme.fg("text", text(value.node_id, this.detailId))}`,
		);
		lines.push(this.muted(text(value.effective_status, "unknown")));
		lines.push("");
		lines.push(this.section(" TEXT ", width));
		lines.push(...this.wrapped(text(value.text, "(empty)"), width, 0));
		lines.push("");
		lines.push(this.section(" PROVENANCE ", width));
		lines.push(...this.field("task", value.task_id, width));
		lines.push(...this.field("episode", value.episode_id, width));
		lines.push(...this.field("source", value.origin_event_id, width));
		lines.push(...this.field("created", value.created_at, width));
		lines.push("");
		lines.push(this.section(" CRITERION / OBSERVED ", width));
		lines.push(...this.field("criterion", value.criterion, width));
		lines.push(...this.field("observed", value.observed, width));
		lines.push(...this.field("outcome", value.outcome_id ?? "none", width));
		lines.push("");
		lines.push(this.section(" REFS / HISTORY ", width));
		lines.push(...this.field("sources", value.source_refs, width));
		lines.push(...this.field("evidence", value.evidence_refs, width));
		lines.push(...this.field("superseded", value.superseded_by ?? "—", width));
		lines.push(...this.field("reason", value.supersede_reason ?? value.downgrade_reason ?? "—", width));
		return this.trimDetail(lines, height, width);
	}

	private evidenceLines(width: number, height: number): string[] {
		const steps = (this.page?.items ?? []) as Record<string, unknown>[];
		const lines: string[] = [];
		const task = text(this.snapshot?.current?.taskId, "task unknown");
		lines.push(this.theme.style(`EVIDENCE · ${task}`, { fg: "accent", bold: true }));
		lines.push(
			this.compose(
				this.muted("验证阶梯只描述已观测/已判定的事实；不执行提交或授权。"),
				this.dim(`rev ${text(this.revision)}`),
				width,
			),
		);
		const compact = height < 24;
		for (let index = 0; index < steps.length; index++) {
			const step = steps[index];
			if (!step) continue;
			const status = text(step.status, "UNKNOWN");
			lines.push(
				`${this.dim(String(index + 1).padStart(2, "0"))} ${this.theme.fg("text", text(step.label, "STEP"))} ${this.plainBadge(status, evidenceTone(status))}`,
			);
			lines.push(...this.wrapped(`proves: ${text(step.proves, "unknown")}`, width, 3));
			lines.push(...this.wrapped(`does not: ${text(step.doesNotProve, "unknown")}`, width, 3));
			if (!compact && index < steps.length - 1) lines.push("");
		}
		lines.push(this.section(" TRUST BOUNDARY ", width));
		for (const line of compact
			? ["transport ≠ passed", "claim ≠ fact", "fact ≠ outcome"]
			: ["transport ok ≠ task passed", "model claim ≠ fact", "fact ≠ Outcome", "no Outcome is not success"]) {
			lines.push(...this.wrapped(`▌ ${line}`, width, 0));
		}
		if (this.snapshot?.integrity.ok !== true) {
			lines.push(this.fg("error", "INTEGRITY UNAVAILABLE · evidence statuses are UNKNOWN"));
		}
		return this.trimDetail(lines, height, width);
	}

	private asideLines(width: number, height: number): string[] {
		const lines: string[] = [];
		const snapshot = this.snapshot;
		lines.push(this.section(" TRUST BOUNDARY ", width));
		for (const line of ["transport ≠ passed", "claim ≠ fact", "fact ≠ outcome", "no outcome ≠ success"]) {
			lines.push(...this.wrapped(`▌ ${line}`, width, 0, "muted"));
		}
		lines.push("");
		lines.push(this.section(" COUNTS ", width));
		const board = snapshot?.counts?.board ?? {};
		const judged = (board.Fact?.current ?? 0) + (board.Refuted?.current ?? 0);
		const observed = (board.Artifact?.current ?? 0) + (board.Origin?.current ?? 0);
		for (const [label, value] of [
			["judged", judged],
			["observed", observed],
			["pending", snapshot?.pending?.length ?? null],
			["unresolved", snapshot?.budgets?.unresolved ?? null],
		] as const) {
			lines.push(
				this.compose(this.muted(label), this.theme.fg("text", value === null ? "unknown" : String(value)), width),
			);
		}
		lines.push("");
		lines.push(this.section(" CURRENT ", width));
		lines.push(...this.field("task", snapshot?.current?.taskId, width));
		lines.push(...this.field("state", snapshot?.current?.state, width));
		lines.push(...this.field("episode", snapshot?.current?.episodeId, width));
		lines.push(...this.field("session", shortValue(snapshot?.current?.sessionId, 26), width));
		lines.push("");
		lines.push(this.section(" SOURCE ", width));
		lines.push(...this.field("revision", this.revision, width));
		lines.push(...this.field("integrity", snapshot?.integrity?.status, width));
		lines.push(...this.field("truncated", snapshot?.health?.truncated === true ? "yes" : "no", width));
		lines.push("");
		lines.push(this.section(" LADDER ", width));
		for (const step of (this.evidence?.steps ?? []).slice(0, 4)) {
			const status = text(step.status, "UNKNOWN");
			lines.push(
				`${this.plainBadge(status, evidenceTone(status))} ${this.fill(text(step.label, "STEP"), Math.max(4, width - 12))}`,
			);
		}
		if (this.snapshot?.campaign?.criteria?.length) {
			lines.push("");
			lines.push(this.section(" CAMPAIGN CRITERIA ", width));
			for (const criterion of this.snapshot.campaign.criteria.slice(0, 4)) {
				lines.push(...this.wrapped(`• ${criterion}`, width, 0));
			}
		}
		const recent = this.snapshot?.recent ?? [];
		if (recent.length > 0) {
			lines.push("");
			lines.push(this.section(" RECENT ", width));
			for (const event of recent.slice(0, 5)) {
				lines.push(
					`${this.dim(text(event.event_type, "event"))} ${this.fill(shortValue(event.episode_id, 20), Math.max(4, width - 24))}`,
				);
			}
		}
		lines.push("");
		lines.push(...this.wrapped("UI 只读；不执行 work-verify / submit / authorize。", width, 0, "muted"));
		return this.fitList(lines, height, width);
	}

	private field(label: string, value: unknown, width: number): string[] {
		const labelWidth = Math.min(14, Math.max(8, Math.floor(width * 0.3)));
		const labelText = this.dim(label.padEnd(labelWidth));
		const valueText = displayValue(value);
		const valueWidth = Math.max(4, width - labelWidth - 1);
		const wrapped = wrapTextWithAnsi(valueText, valueWidth);
		const lines = wrapped.length > 0 ? wrapped : [""];
		return lines.map((line, index) =>
			index === 0
				? `${labelText} ${this.theme.fg("text", line)}`
				: `${" ".repeat(labelWidth)} ${this.theme.fg("text", line)}`,
		);
	}

	private wrapped(value: string, width: number, indent: number, tone: Tone = "muted"): string[] {
		const available = Math.max(4, width - indent);
		return wrapTextWithAnsi(value, available).map((line) => `${" ".repeat(indent)}${this.fg(tone, line)}`);
	}

	private trimDetail(lines: string[], height: number, width: number): string[] {
		const result = lines.slice(0, height);
		if (lines.length > height && height > 0) result[height - 1] = this.dim("… 详情被截断；仅显示有界摘要");
		return result.map((line) => this.fill(line, width));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = (event.wheelDelta ?? 0) > 0 ? 1 : -1;
			this.move(delta);
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left") {
			const hit = this.hitRows.find(
				(row) => event.y >= row.start && event.y <= row.end && event.x > 0 && event.x <= this.masterHitWidth,
			);
			if (!hit) return undefined;
			this.selected = hit.index;
			this.loadDetail();
			if (this.lastWidth < 100) this.showDetail = true;
			this.tui.requestRender();
			return { handled: true, focus: true, render: true };
		}
		return undefined;
	}

	/* -------------------------------------------------------------- lifecycle */

	invalidate(): void {
		// Rendering is stateless except for the committed snapshot. There is no cached
		// ANSI output; a theme change simply requests the next render.
		this.tui.requestRender();
	}

	dispose(): void {
		this.disposed = true;
	}
}

/** Open the full-screen Aegis Inspector without taking ownership of Pi's editor. */
export async function openAegisTui(
	ctx: ExtensionContext,
	readCommitted: () => unknown,
	initialTab: Tab = "graph",
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/aegis ui 需要 Pi 交互式 TUI 模式", "warning");
		return;
	}
	const source = createAegisTuiDataSource(readCommitted as Parameters<typeof createAegisTuiDataSource>[0]);
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => new AegisInspector(tui, theme, keybindings, source, done, initialTab),
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}
