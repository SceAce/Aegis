// Technique card schema v2 with v1 compatibility.
//
// A card is guidance material, never proof and never an action grant. The v1
// model collapsed two orthogonal facts into `status: "verified"`: how carefully
// the text was curated, and whether independent evidence backs it. A card whose
// only source is the wiki cannot be evidence-verified (MEMORY_SCHEMA §6.2b), yet
// auto-injection keyed off that single boolean.
//
// v2 splits them:
//   curation: draft | reviewed | disputed      (text quality)
//   evidence: none | document | outcome | reproduction
// and derives injectability from both, so nothing is lost: today's 47 cards are
// exactly reviewed + document, which is what `verified` used to mean in practice.
//
// `reproduction` points at a HUMAN-REGISTERED script action (execution/
// script-registry.mjs) by id+version and pins its digest. A card never carries an
// executable, argv, shell text or eval string: THINK.md §9 still lists "may
// Experience carry arbitrary scripts" as an open question, so this module must
// not answer it by smuggling code into cards.

export const CARD_SCHEMA_VERSION = "2.0";
export const CURATION_VALUES = Object.freeze(["draft", "reviewed", "disputed"]);
export const EVIDENCE_KINDS = Object.freeze(["none", "document", "outcome", "reproduction"]);
export const ANY_ENVIRONMENT = "any";

const MAX_STRING = 400;
const MAX_ITEMS = 32;

// Fields that would turn a card into an executable payload. Their presence is a
// rejection, not something to sanitise.
const FORBIDDEN_FIELDS = Object.freeze([
	"command",
	"executable",
	"argv",
	"args",
	"shell",
	"eval",
	"script_text",
	"code",
	"payload",
]);

const SCRIPT_REF = /^script:([A-Za-z0-9][A-Za-z0-9._-]*)(?:@(\d+))?$/;

function asStringArray(value, { max = MAX_ITEMS, maxLength = MAX_STRING } = {}) {
	if (!Array.isArray(value)) return null;
	const out = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		const trimmed = entry.trim();
		if (!trimmed || trimmed.length > maxLength) return null;
		out.push(trimmed);
		if (out.length > max) return null;
	}
	return out;
}

function boundedString(value, maxLength = MAX_STRING) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * Parse a `script:<id>@<version>` reference.
 * @returns {{scriptId: string, version: number} | null}
 */
export function parseScriptRef(ref) {
	if (typeof ref !== "string") return null;
	const match = SCRIPT_REF.exec(ref.trim());
	if (!match) return null;
	return { scriptId: match[1], version: match[2] === undefined ? null : Number(match[2]) };
}

/**
 * Validate a v2 evidence block. `reproduction` must reference a registered
 * script action and pin its digest; refs of other kinds are opaque labels.
 * @returns {{ok: boolean, reason?: string, evidence?: object}}
 */
export function parseEvidence(raw) {
	if (raw === undefined || raw === null) return { ok: true, evidence: { kind: "none", refs: [] } };
	if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "evidence must be an object" };
	const kind = boundedString(raw.kind, 32);
	if (!kind || !EVIDENCE_KINDS.includes(kind)) {
		return { ok: false, reason: `evidence.kind must be one of ${EVIDENCE_KINDS.join(", ")}` };
	}
	const refs = raw.refs === undefined ? [] : asStringArray(raw.refs, { max: 12, maxLength: 200 });
	if (refs === null) return { ok: false, reason: "evidence.refs must be <=12 strings of <=200 chars" };

	if (kind === "none" && refs.length > 0) return { ok: false, reason: "evidence.kind=none cannot carry refs" };
	if (kind === "outcome" && refs.length === 0)
		return { ok: false, reason: "evidence.kind=outcome needs at least one ref" };

	if (kind === "reproduction") {
		if (refs.length === 0) return { ok: false, reason: "evidence.kind=reproduction needs a script ref" };
		for (const ref of refs) {
			const parsed = parseScriptRef(ref);
			if (!parsed || parsed.version === null) {
				// A version is mandatory: the digest pins the implementation, the version
				// pins which reviewed registration it belongs to. Without it a card could
				// silently attach to a later, different script.
				return { ok: false, reason: `reproduction ref must look like script:<id>@<version>, got ${ref}` };
			}
		}
		const digest = boundedString(raw.implementation_digest, 200);
		if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
			return { ok: false, reason: "reproduction evidence needs implementation_digest sha256:<64 hex>" };
		}
		return { ok: true, evidence: { kind, refs, implementation_digest: digest } };
	}
	return { ok: true, evidence: { kind, refs } };
}

/** Reject any field that would make a card carry executable content. */
export function findForbiddenFields(raw) {
	if (!raw || typeof raw !== "object") return [];
	const found = [];
	for (const field of FORBIDDEN_FIELDS) {
		if (raw[field] !== undefined && raw[field] !== null && raw[field] !== "") found.push(field);
	}
	// Nested evidence must not smuggle them either.
	const evidence = raw.evidence;
	if (evidence && typeof evidence === "object") {
		for (const field of FORBIDDEN_FIELDS) {
			if (evidence[field] !== undefined && evidence[field] !== null && evidence[field] !== "")
				found.push(`evidence.${field}`);
		}
	}
	return found;
}

/**
 * True when a card may be injected automatically.
 *
 * This is a DERIVED predicate, not an authored flag: a card is injectable when
 * its text was reviewed, it carries actual evidence, its scope matches, and every
 * trigger was observed. `reproduction` additionally requires the digest to match
 * the registered script action.
 */
export function isInjectable(card, { scopeMatches = true, triggersMet = true, scriptDigests = null } = {}) {
	if (!card || typeof card !== "object") return false;
	if (!CURATION_VALUES.includes(card.curation)) return false;
	if (card.curation !== "reviewed") return false;
	const evidence = card.evidence;
	if (!evidence || !EVIDENCE_KINDS.includes(evidence.kind) || evidence.kind === "none") return false;
	if (evidence.kind === "reproduction" && reproductionProblem(card, scriptDigests) !== null) return false;
	return scopeMatches === true && triggersMet === true;
}

/**
 * Explain why a reproduction card cannot be trusted, or null when it checks out.
 * Kept separate from `isInjectable` so callers can report a precise reason.
 */
export function reproductionProblem(card, scriptDigests) {
	const evidence = card?.evidence;
	if (!evidence || evidence.kind !== "reproduction") return null;
	if (!Array.isArray(evidence.refs) || evidence.refs.length === 0) return "no script ref";
	if (typeof evidence.implementation_digest !== "string") return "no implementation_digest";
	if (!scriptDigests) return "no script registry configured (set AEGIS_SCRIPT_CONFIG)";
	for (const ref of evidence.refs) {
		const parsed = parseScriptRef(ref);
		if (!parsed || parsed.version === null) return `${ref} is not script:<id>@<version>`;
		const registered = resolveDigest(scriptDigests, parsed.scriptId, parsed.version);
		if (!registered) return `${ref} is not registered`;
		if (registered !== evidence.implementation_digest) {
			return `${ref} digest ${evidence.implementation_digest} does not match the registered ${registered}`;
		}
	}
	return null;
}

/**
 * Read the pinned digest for `id@version` from either a resolver function or a
 * plain map. Two map keys are accepted so callers can pass either the registry
 * index (`id@version`) or a simple `id` map in tests.
 */
function resolveDigest(scriptDigests, scriptId, version) {
	if (typeof scriptDigests === "function") {
		const value = scriptDigests(scriptId, version);
		return typeof value === "string" && value ? value : null;
	}
	if (typeof scriptDigests !== "object") return null;
	const keyed = scriptDigests[`${scriptId}@${version}`];
	if (typeof keyed === "string") return keyed;
	const byId = scriptDigests[scriptId];
	if (typeof byId === "string") return byId;
	if (byId && typeof byId === "object") {
		if (byId.version !== undefined && byId.version !== version) return null;
		return typeof byId.digest === "string" ? byId.digest : null;
	}
	return null;
}

/**
 * Build a digest resolver from a script registry (execution/script-registry.mjs).
 *
 * The pinned implementation digest is the script body when the registration runs
 * through an interpreter (that file IS the technique), otherwise the executable.
 */
export function scriptDigestResolver(registry) {
	if (!registry || typeof registry.get !== "function") return null;
	return (scriptId, version) => {
		const registration = registry.get(scriptId, version);
		if (!registration) return null;
		if (typeof registration.script_digest === "string" && registration.script_digest) return registration.script_digest;
		if (typeof registration.executable_digest === "string" && registration.executable_digest)
			return registration.executable_digest;
		return null;
	};
}

/**
 * Parse one card. Accepts v2 and v1.
 *
 * v1 mapping: status=verified -> curation=reviewed + evidence document (the v1
 * field was only ever set on wiki-derived cards); status=candidate -> draft;
 * `when` -> `triggers`; `expect` -> `postconditions`.
 *
 * @returns {{ok: true, card: object} | {ok: false, reason: string}}
 */
export function parseCard(raw, { index = 0 } = {}) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: `card[${index}] is not an object` };
	}
	const forbidden = findForbiddenFields(raw);
	if (forbidden.length > 0) {
		return { ok: false, reason: `card[${index}] carries forbidden field(s): ${forbidden.join(", ")}` };
	}
	const id = boundedString(raw.id, 120);
	if (!id) return { ok: false, reason: `card[${index}] has no id` };
	const title = boundedString(raw.title, 200);
	if (!title) return { ok: false, reason: `card ${id} has no title` };
	const revision = boundedString(String(raw.revision ?? ""), 40);
	if (!revision) return { ok: false, reason: `card ${id} has no revision` };

	const scopeRaw = raw.scope && typeof raw.scope === "object" && !Array.isArray(raw.scope) ? raw.scope : null;
	if (!scopeRaw) return { ok: false, reason: `card ${id} has no scope object` };
	const taskCategory = boundedString(scopeRaw.task_category, 60);
	if (!taskCategory) return { ok: false, reason: `card ${id} has no scope.task_category` };
	const environment = boundedString(scopeRaw.environment, 60);
	if (!environment) return { ok: false, reason: `card ${id} has no scope.environment` };

	const triggers = asStringArray(raw.triggers ?? raw.when);
	if (triggers === null) return { ok: false, reason: `card ${id} triggers must be an array of short strings` };
	if (triggers.length === 0) return { ok: false, reason: `card ${id} has no triggers` };
	const hint = asStringArray(raw.hint);
	if (hint === null) return { ok: false, reason: `card ${id} hint must be an array of short strings` };
	if (hint.length === 0) return { ok: false, reason: `card ${id} has no hint` };

	const preconditions = raw.preconditions === undefined ? [] : asStringArray(raw.preconditions);
	if (preconditions === null) return { ok: false, reason: `card ${id} preconditions must be strings` };
	const postconditions =
		raw.postconditions === undefined
			? raw.expect === undefined
				? []
				: [boundedString(raw.expect, MAX_STRING)].filter(Boolean)
			: asStringArray(raw.postconditions);
	if (postconditions === null) return { ok: false, reason: `card ${id} postconditions must be strings` };
	const limits = raw.limits === undefined ? [] : asStringArray(raw.limits);
	if (limits === null) return { ok: false, reason: `card ${id} limits must be strings` };
	const verification = raw.verification === undefined ? null : boundedString(raw.verification, MAX_STRING);

	// curation: v2 field wins, else derive from v1 status.
	let curation = boundedString(raw.curation, 20);
	if (!curation) {
		if (raw.status === "verified") curation = "reviewed";
		else if (raw.status === "candidate") curation = "draft";
		else return { ok: false, reason: `card ${id} has neither curation nor a recognised status` };
	}
	if (!CURATION_VALUES.includes(curation)) {
		return { ok: false, reason: `card ${id} curation must be one of ${CURATION_VALUES.join(", ")}` };
	}

	// evidence: v2 block wins, else derive from v1 status/source_refs.
	let evidence;
	if (raw.evidence !== undefined) {
		const parsed = parseEvidence(raw.evidence);
		if (!parsed.ok) return { ok: false, reason: `card ${id}: ${parsed.reason}` };
		evidence = parsed.evidence;
	} else {
		const sourceRefs = asStringArray(raw.source_refs ?? [], { max: 12, maxLength: 300 }) ?? [];
		evidence = sourceRefs.length > 0 ? { kind: "document", refs: sourceRefs } : { kind: "none", refs: [] };
	}

	const source = parseSource(raw.source, raw.source_refs);
	const review = parseReview(raw.review);

	return {
		ok: true,
		card: {
			schema_version: CARD_SCHEMA_VERSION,
			id,
			revision,
			title,
			curation,
			evidence,
			scope: { task_category: taskCategory, environment },
			triggers,
			preconditions,
			hint,
			postconditions,
			verification,
			limits,
			...(source ? { source } : {}),
			...(review ? { review } : {}),
		},
	};
}

function parseSource(rawSource, legacyRefs) {
	if (rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)) {
		const kind = boundedString(rawSource.kind, 60);
		const uri = boundedString(rawSource.uri, 500);
		if (!kind || !uri) return null;
		const digest = boundedString(rawSource.digest, 200);
		const commit = boundedString(rawSource.commit, 80);
		const section = boundedString(rawSource.section, 200);
		return {
			kind,
			uri,
			...(digest ? { digest } : {}),
			...(commit ? { commit } : {}),
			...(section ? { section } : {}),
		};
	}
	// v1: the first source_refs entry was the wiki URL.
	const first = Array.isArray(legacyRefs)
		? legacyRefs.find((entry) => typeof entry === "string" && entry.trim())
		: null;
	if (!first) return null;
	const commit = /\/blob\/([0-9a-f]{7,40})\//.exec(first)?.[1] ?? null;
	const section = first.includes("#") ? decodeURIComponent(first.split("#").slice(1).join("#")) : null;
	return { kind: "ctf-wiki", uri: first.trim(), ...(commit ? { commit } : {}), ...(section ? { section } : {}) };
}

function parseReview(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const by = boundedString(raw.by, 80);
	if (!by) return null;
	const at = boundedString(raw.at, 40);
	const against = boundedString(raw.against_commit, 80);
	return { by, ...(at ? { at } : {}), ...(against ? { against_commit: against } : {}) };
}

/**
 * Parse a whole card file: either `{cards: [...]}` or a bare array.
 * @returns {{ok: boolean, cards: object[], errors: string[]}}
 */
export function parseCards(value) {
	const list = Array.isArray(value) ? value : value && typeof value === "object" ? value.cards : null;
	if (!Array.isArray(list)) return { ok: false, cards: [], errors: ["card file must be an array or { cards: [...] }"] };
	const cards = [];
	const errors = [];
	const seen = new Set();
	for (const [index, entry] of list.entries()) {
		const parsed = parseCard(entry, { index });
		if (!parsed.ok) {
			errors.push(parsed.reason);
			continue;
		}
		if (seen.has(parsed.card.id)) {
			errors.push(`duplicate card id: ${parsed.card.id}`);
			continue;
		}
		seen.add(parsed.card.id);
		cards.push(parsed.card);
	}
	return { ok: errors.length === 0, cards, errors };
}
