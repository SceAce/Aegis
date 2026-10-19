import { buildE1Explorer, buildE1StateRevision, buildE1View } from "../e1-observation.mjs";

const PAGE_SIZE = 6;

function currentView(readCommitted) {
	const input = readCommitted();
	if (!input || typeof input !== "object") throw new Error("committed source unavailable");
	const manifestValid = Boolean(input.manifest && typeof input.manifest === "object" && !Array.isArray(input.manifest));
	const eventsValid = Array.isArray(input.events);
	const reasons = [];
	if (!manifestValid) reasons.push("Campaign Manifest is not configured or invalid");
	if (!eventsValid) reasons.push("EventLog rows are unavailable");
	if (input.integrityOk !== true) reasons.push("EventLog chain is not verified");
	const source = {
		...input,
		manifest: manifestValid ? input.manifest : { campaign_id: null, revision: null, tasks: [], objective: {} },
		integrityOk: input.integrityOk === true && manifestValid && eventsValid,
		manifestValid,
		eventsValid,
		reasons,
		events: eventsValid ? input.events : [],
	};
	const { manifest, events, integrityOk } = source;
	const projectionEvents = integrityOk ? events : [];
	const view = buildE1View({ manifest, events: projectionEvents, integrityOk });
	const revision = buildE1StateRevision({
		manifest,
		board: view.board,
		graph: view.task_graph,
		projection: view.projection,
	});
	return { source, view, revision: revision.state_revision };
}

function assertRevision(actual, requested) {
	if (!requested || actual !== requested) throw new Error("state changed; refresh required");
}

function evidenceLadder(source, view) {
	if (source.integrityOk !== true) {
		return ["TRANSPORT", "OBSERVATION", "INDEPENDENT CHECK", "OUTCOME"].map((label) => ({
			id: label.toLowerCase().replaceAll(" ", "-"),
			label,
			status: "UNKNOWN",
			proves: "EventLog integrity unavailable; current evidence cannot be derived",
			doesNotProve: "当前状态不可判定，不代表未运行或成功",
		}));
	}
	const belongsToCurrent = (row) => {
		const taskId = row?.task_id ?? row?.payload?.task_id;
		const episodeId = row?.episode_id ?? row?.payload?.episode_id;
		return Boolean((source.taskId && taskId === source.taskId) || (source.episodeId && episodeId === source.episodeId));
	};
	const events = source.integrityOk === true ? source.events.filter(belongsToCurrent) : [];
	const nodes = (view.board?.nodes ?? []).filter(belongsToCurrent);
	const current = (type) => nodes.filter((node) => node.type === type && node.effective !== false);
	const trustedAction = (event) => ["runtime", "oracle", "human"].includes(event?.source?.kind);
	const requested = events.some((event) => event.event_type === "action.requested" && trustedAction(event));
	const completed = events.some((event) => event.event_type === "action.completed" && trustedAction(event));
	const artifacts = current("Artifact");
	const judgments = [...current("Fact"), ...current("Refuted")];
	const outcomes = judgments.filter((node) => node.outcome_id);
	return [
		{
			id: "transport",
			label: "TRANSPORT",
			status: completed ? "DONE" : requested ? "PARTIAL" : "NOT RUN",
			proves: completed
				? "已记录动作完成事件"
				: requested
					? "只记录了动作请求，执行结果尚未观测"
					: "尚未证明发生过动作传输",
			doesNotProve: "不证明任务成功或结果有效",
		},
		{
			id: "observation",
			label: "OBSERVATION",
			status: artifacts.length > 0 ? "DONE" : completed ? "PARTIAL" : "NOT RUN",
			proves: artifacts.length > 0 ? `已记录 Artifact ${artifacts.length} 项` : "工具完成但没有可用 Artifact 节点",
			doesNotProve: "不证明独立判断或 Outcome",
		},
		{
			id: "independent",
			label: "INDEPENDENT CHECK",
			status: judgments.length > 0 ? "DONE" : "NOT RUN",
			proves: judgments.length > 0 ? `当前有 Fact/Refuted ${judgments.length} 项` : "没有当前有效的独立 Fact/Refuted",
			doesNotProve: "独立判断不等于任务整体 Outcome",
		},
		{
			id: "outcome",
			label: "OUTCOME",
			status: outcomes.length > 0 ? "DONE" : "NOT RUN",
			proves: outcomes.length > 0 ? `当前有效独立判断关联 Outcome ${outcomes.length} 项` : "当前没有可用的独立 Outcome",
			doesNotProve: "缺失、unknown 或 stale 时不宣布成功",
		},
	];
}

function explorerPage(source, view, revision, query) {
	let explorerCursor = query.cursor;
	if (explorerCursor) {
		const separator = explorerCursor.indexOf("|");
		if (separator < 1 || explorerCursor.slice(0, separator) !== revision)
			throw new Error("state changed; refresh required");
		explorerCursor = explorerCursor.slice(separator + 1);
	}
	const result = buildE1Explorer({
		manifest: source.manifest,
		events: source.integrityOk === true ? source.events : [],
		board: view.board,
		authorityProjection: view.projection,
		query: { ...query, cursor: explorerCursor, since_state_revision: revision },
		integrityOk: source.integrityOk === true,
	});
	if (!result.ok) throw new Error(result.errors.join("; "));
	if (result.version?.state_changed === true) throw new Error("state changed; refresh required");
	const items = result.nodes ?? [];
	return {
		revision,
		items,
		total: result.total ?? items.length,
		returned: result.returned ?? items.length,
		offset: result.offset ?? 0,
		limit: result.page_size ?? PAGE_SIZE,
		truncated: result.truncated === true,
		nextCursor: result.next_cursor ? `${revision}|${result.next_cursor}` : null,
		previousCursor:
			result.prev_offset === null || result.prev_offset === undefined
				? null
				: `${revision}|off:${result.prev_offset}:f:${result.filter_digest?.replace(/^sha256:/, "").slice(0, 16)}`,
		edges: Array.isArray(result.edges?.items) ? result.edges.items : [],
	};
}

export function createAegisTuiDataSource(readCommitted) {
	if (typeof readCommitted !== "function") throw new TypeError("readCommitted must be a function");
	return Object.freeze({
		snapshot() {
			const { source, view, revision } = currentView(readCommitted);
			const graph = view.task_graph ?? {};
			const requests = view.requests ?? {};
			const manifest = source.manifest;
			const taskStates = {};
			for (const node of graph.nodes ?? []) {
				taskStates[node.state ?? "unknown"] = (taskStates[node.state ?? "unknown"] ?? 0) + 1;
			}
			const currentTask = (graph.nodes ?? []).find((node) => node.task_id === source.taskId) ?? null;
			const counts = view.board?.by_type ?? {};
			const historyCounts = view.board?.history_by_type ?? {};
			return {
				revision,
				generatedAt: new Date().toISOString(),
				integrity: {
					ok: source.integrityOk === true,
					status:
						source.integrityOk === true
							? "verified"
							: source.manifestValid !== true
								? "manifest_unavailable"
								: "integrity_unavailable",
					lastOffset: source.events.length > 0 ? source.events.length - 1 : null,
				},
				campaign: {
					id: manifest.campaign_id ?? null,
					control: source.integrityOk === true ? "committed" : "unavailable",
					manifestRevision: manifest.revision ?? null,
					title: manifest.title ?? null,
					objective: manifest.objective?.description ?? null,
					criteria: Array.isArray(manifest.objective?.success_criteria)
						? manifest.objective.success_criteria.slice(0, 12).map(String)
						: [],
				},
				current: {
					taskId: source.taskId ?? null,
					state: currentTask?.state ?? null,
					episodeId: source.episodeId ?? currentTask?.episode_id ?? null,
					sessionId: source.sessionId ?? null,
				},
				budgets: {
					consumed: {
						tool_calls:
							requests.consumed && requests.consumed.tool_calls !== undefined ? requests.consumed.tool_calls : null,
						model_requests:
							requests.consumed && requests.consumed.model_requests !== undefined
								? requests.consumed.model_requests
								: null,
					},
					reserved: {
						campaign: Array.isArray(requests.campaign_pending) ? requests.campaign_pending.length : null,
						task: Array.isArray(requests.task_pending) ? requests.task_pending.length : null,
					},
					unresolved: requests.unresolved ?? null,
				},
				counts: {
					tasks: taskStates,
					board: Object.fromEntries(
						Object.keys({ ...counts, ...historyCounts }).map((type) => [
							type,
							{
								current: counts[type] ?? 0,
								history: historyCounts[type] ?? 0,
							},
						]),
					),
				},
				pending: [
					...(Array.isArray(requests.task_pending) ? requests.task_pending : []),
					...(Array.isArray(requests.campaign_pending) ? requests.campaign_pending : []),
				]
					.slice(0, 20)
					.map((row) => ({
						id: String(row.request_id ?? row.reservation_id ?? "unknown"),
						kind: String(row.kind ?? "request"),
						status: "pending",
						reason: "reserved request hold",
						taskId: row.task_id ?? null,
					})),
				recent:
					source.integrityOk === true
						? source.events
								.filter(
									(event) =>
										/^(action|proposal|outcome|environment|node|handoff|campaign|experience)\./.test(
											String(event.event_type ?? ""),
										) || event.event_type === "runtime.note",
								)
								.slice(-8)
								.reverse()
								.map((event) => ({
									event_id: event.event_id ?? null,
									event_type: event.event_type ?? null,
									episode_id: event.episode_id ?? null,
									source_kind: event.source?.kind ?? null,
									sequence: event.sequence ?? null,
									occurred_at: event.recorded_at ?? event.occurred_at ?? null,
								}))
						: [],
				health: {
					stale: source.integrityOk !== true,
					truncated:
						view.board?.truncated === true ||
						(graph.diagnostics ?? []).some((entry) => entry?.code === "tasks_truncated"),
					warnings: source.reasons.length > 0 ? [...source.reasons] : [],
				},
			};
		},
		taskPage(query = {}) {
			const { source, view, revision } = currentView(readCommitted);
			assertRevision(revision, query.revision);
			return explorerPage(source, view, revision, {
				kind: "graph",
				page_size: PAGE_SIZE,
				status: query.status,
				q: query.filter,
				cursor: query.cursor,
			});
		},
		boardPage(query = {}) {
			const { source, view, revision } = currentView(readCommitted);
			assertRevision(revision, query.revision);
			return explorerPage(source, view, revision, {
				kind: "board",
				page_size: PAGE_SIZE,
				type: query.type,
				status: query.scope === "history" ? undefined : "current",
				q: query.filter,
				cursor: query.cursor,
			});
		},
		evidence() {
			const { source, view, revision } = currentView(readCommitted);
			return { revision, steps: evidenceLadder(source, view) };
		},
		detail(ref) {
			const { source, view, revision } = currentView(readCommitted);
			assertRevision(revision, ref.revision);
			if (ref.kind === "task") {
				const result = buildE1Explorer({
					manifest: source.manifest,
					events: source.integrityOk === true ? source.events : [],
					board: view.board,
					integrityOk: source.integrityOk === true,
					query: { kind: "graph", task_id: ref.id, page_size: 1 },
				});
				if (!result.ok || result.scope !== "graph_detail") return { status: "not_found", revision };
				return { status: "available", revision, value: result.detail };
			}
			if (ref.kind === "board-node") {
				const node = (view.board?.nodes ?? []).find((item) => item.node_id === ref.id);
				return node ? { status: "available", revision, value: node } : { status: "not_found", revision };
			}
			return {
				status: "unavailable",
				revision,
				reason: "Outcome detail is not exposed by the current committed projection",
			};
		},
	});
}

export const AEGIS_TUI_PAGE_SIZE = PAGE_SIZE;
