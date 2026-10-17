// Aegis OBS-01 — the read-only E1 exploration client served at `/e1-explorer.js`.
//
// This is a STATIC asset: it reads the bootstrap JSON from a `<script
// type="application/json">` element in the page and only ever issues GET requests
// to the read-only exploration API. It cannot pause, cancel, authorize, resume or
// call a model — no such route exists to call.
//
// It never builds markup from data: every dynamic value is written with
// `textContent` or via `createElement`, so a hostile node text stays text.
//
// Exported as a string (not a file) so the observation server needs no extra
// filesystem read and the asset cannot be replaced by a path parameter.

export const E1_EXPLORER_CLIENT_JS = `(() => {
	"use strict";
	const byId = (id) => document.getElementById(id);
	const rows = byId("e1-rows");
	const detail = byId("e1-detail");
	const statusLine = byId("e1-status-line");
	const revisionEl = byId("e1-revision");
	const truncationEl = byId("e1-truncation");
	const kindEl = byId("e1-kind");
	const filterEl = byId("e1-filter");
	const statusEl = byId("e1-status");
	const pageSizeEl = byId("e1-page-size");
	const prevBtn = byId("e1-prev");
	const nextBtn = byId("e1-next");
	const autoEl = byId("e1-auto");
	const bootstrapEl = byId("e1-bootstrap");
	if (!rows || !bootstrapEl) return;
	const bootstrap = JSON.parse(bootstrapEl.getAttribute("data-bootstrap") || "{}");
	// The revision this page was SERVED from. Paging across a different committed
	// state is refused so two states are never stitched into one listing.
	let startRevision = bootstrap.state_revision || null;
	let offset = 0;
	let previous = [];
	let timer = null;
	let inFlight = false;

	const setStatus = (text) => { statusLine.textContent = text; };
	const pageSize = () => Math.max(1, Math.min(200, Number(pageSizeEl.value) || 50));

	function buildUrl() {
		const endpoint = kindEl.value === "board" ? "/api/e1/board" : "/api/e1/graph";
		const params = new URLSearchParams();
		params.set("page_size", String(pageSize()));
		params.set("page", String(Math.floor(offset / pageSize())));
		if (startRevision) params.set("since_state_revision", startRevision);
		const state = statusEl.value.trim();
		if (state) params.set("status", state);
		const filter = filterEl.value.trim();
		if (filter) {
			if (kindEl.value === "graph") params.set("task_id", filter);
			else params.set("q", filter);
		}
		return endpoint + "?" + params.toString();
	}

	function clearRows() { while (rows.firstChild) rows.removeChild(rows.firstChild); }

	function showDetail(payload) {
		detail.hidden = false;
		detail.textContent = JSON.stringify(payload, null, 2);
	}

	function rowLabel(row, kind) {
		if (kind === "graph") {
			const deps = Array.isArray(row.depends_on) && row.depends_on.length ? " deps=[" + row.depends_on.join(", ") + "]" : "";
			return row.task_id + " — state=" + row.state + deps;
		}
		return row.type + " [" + row.effective_status + "] task=" + (row.task_id || "-") + ": " + (row.text || "");
	}

	async function openDetail(row, kind) {
		const url = kind === "graph"
			? "/api/e1/node?task_id=" + encodeURIComponent(String(row.task_id || ""))
			: "/api/e1/board?page_size=1&q=" + encodeURIComponent(String(row.node_id || ""));
		const response = await fetch(url, { method: "GET" });
		const payload = await response.json();
		if (payload.foreign_reference) {
			setStatus("detail refused: " + (payload.error || "unknown reference"));
			showDetail(payload);
			return;
		}
		setStatus("detail for " + (row.task_id || row.node_id));
		showDetail(payload);
	}

	function renderRow(row, kind) {
		const li = document.createElement("li");
		const link = document.createElement("a");
		link.href = "#";
		link.textContent = rowLabel(row, kind);
		link.addEventListener("click", (event) => {
			event.preventDefault();
			openDetail(row, kind).catch((error) => setStatus("detail failed: " + String(error)));
		});
		li.appendChild(link);
		return li;
	}

	async function load() {
		if (inFlight) return;
		inFlight = true;
		setStatus("loading…");
		try {
			const response = await fetch(buildUrl(), { method: "GET" });
			const payload = await response.json();
			if (!response.ok) {
				const reason = payload.error || (payload.errors || []).join("; ") || response.statusText;
				setStatus("error " + response.status + ": " + reason);
				return;
			}
			if (payload.version && payload.version.state_changed === true) {
				setStatus("committed state changed since this page was served — reload the page to continue");
				nextBtn.disabled = true;
				prevBtn.disabled = true;
				return;
			}
			if (payload.version && payload.version.state_revision) { startRevision = payload.version.state_revision; revisionEl.textContent = startRevision; }
			clearRows();
			const items = Array.isArray(payload.nodes) ? payload.nodes : [];
			for (const row of items) rows.appendChild(renderRow(row, kindEl.value));
			truncationEl.textContent = payload.truncated
				? "Showing " + payload.returned + " of " + payload.total + " rows (offset " + payload.offset + "); more remain."
				: "All " + payload.total + " rows fit on this page.";
			nextBtn.disabled = !payload.next_cursor;
			prevBtn.disabled = previous.length === 0;
			setStatus("loaded " + payload.returned + " of " + payload.total + " rows at offset " + payload.offset);
		} catch (error) {
			setStatus("request failed: " + String(error));
		} finally {
			inFlight = false;
		}
	}

	nextBtn.addEventListener("click", () => { previous.push(offset); offset += pageSize(); load(); });
	prevBtn.addEventListener("click", () => { offset = previous.length ? previous.pop() : 0; load(); });
	byId("e1-apply").addEventListener("click", () => { offset = 0; previous = []; load(); });
	byId("e1-refresh").addEventListener("click", () => { startRevision = null; offset = 0; previous = []; load(); });
	byId("e1-stop").addEventListener("click", () => {
		if (timer !== null) { clearInterval(timer); timer = null; }
		autoEl.checked = false;
		setStatus("auto-refresh stopped (read-only; nothing was written)");
	});
	autoEl.addEventListener("change", () => {
		if (autoEl.checked) {
			if (timer === null) timer = setInterval(() => load(), 5000);
			setStatus("auto-refresh every 5s (GET only)");
		} else if (timer !== null) {
			clearInterval(timer);
			timer = null;
			setStatus("auto-refresh off");
		}
	});
	load();
})();
`;
