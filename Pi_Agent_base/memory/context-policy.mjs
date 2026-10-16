// Explicit experiment interventions. Recording and execution controls stay active.
export function contextPolicy(env = process.env) {
	function enabled(name) {
		const value = env[name] ?? "on";
		if (!["on", "off"].includes(value)) throw new Error(`${name} must be on or off`);
		return value === "on";
	}
	return { board: enabled("AEGIS_BOARD_FEEDBACK"), knowledge: enabled("AEGIS_KNOWLEDGE_ENABLED") };
}

export function contextProjectionInput({ board, state, seed, policy }) {
	if (!policy.board) {
		const empty = Object.fromEntries(
			["Origin", "Fact", "Refuted", "Hint", "Intent", "Artifact"].map((type) => [type, []]),
		);
		board = { ...board, byType: empty, currentByType: empty };
		state = { ...state, experience_decisions: [] };
	}
	if (!policy.knowledge) {
		state = { ...state, knowledge_selections: [] };
		seed = null;
	}
	return { board, state, seed };
}
