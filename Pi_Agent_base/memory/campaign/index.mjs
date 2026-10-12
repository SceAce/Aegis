// Aegis Campaign layer — C0 public surface.
//
// C0 adds ONLY the Campaign contract layer above the existing
// `Event -> Episode -> Outcome -> Experience` runtime:
//
//   * immutable `campaign-1.0` Manifest (parse / validate / digest / persist);
//   * typed Campaign/Task/Stage/Episode/Session identifiers;
//   * queue STATE contract (no scheduler yet — that is C1);
//   * bounded dynamic task policy (admit / block / reject);
//   * deterministic stage/task/Campaign aggregation;
//   * deterministic report + acceptance bundle + reviewer prompt;
//   * a deterministic offline fixture Campaign.
//
// C0 does not add Event types, does not touch Pi/Observer/Broker/Web UI, and
// does not create a second Event/Outcome/Experience schema.

export {
	aggregateCampaign,
	aggregateStage,
	aggregateTask,
	classifySupersede,
	contributionLink,
	effectiveOutcomes,
	independenceOf,
	PERSISTED_OUTCOME_STATUSES,
	STAGE_STATUSES,
	TASK_STATUSES,
	validateTaskOracleBinding,
} from "./aggregate.mjs";
export { createBrokerWorker } from "./broker-worker.mjs";
export {
	assembleCampaignHost,
	buildC3FixtureManifest,
	createProductSink,
	ENTRY_VERSION,
	runCampaignHost,
	summarize,
} from "./c3-entry.mjs";
export {
	BROKERED_TOOLS,
	createCampaignActionGate,
	DIRECT_TOOLS_DENIED,
} from "./campaign-mode.mjs";
export {
	ADMISSION_STATUSES,
	admitTaskProposal,
	applyAdmission,
	resolveChainDepth,
	validateTaskProposal,
} from "./dynamic-policy.mjs";
export {
	CAMPAIGN_EVENT_KINDS,
	CAMPAIGN_EVENT_SCHEMA_VERSION,
	CAMPAIGN_EVENT_TYPE,
	CAMPAIGN_KIND_SOURCES,
	campaignEventEnvelope,
	isCampaignEventKind,
	sourcesForKind,
	TRUSTED_EVENT_SOURCES,
	validateCampaignEvent,
} from "./event-contract.mjs";
export {
	buildFixtureCampaign,
	deterministicIdFactory,
	FIXTURE_CREATED_AT,
	FIXTURE_SCOPE,
	fixtureOutcomes,
	persistFixtureCampaign,
} from "./fixture.mjs";
export {
	createFixtureAdapterContract,
	FIXTURE_ADAPTER_ACTION_REF,
	readFixtureState,
} from "./fixture-adapter.mjs";
export { buildBudgetLedger, createCampaignHost, ensureWorkspace, HOST_VERSION } from "./host.mjs";
export { createHostOracle } from "./host-oracle.mjs";
export * from "./identifiers.mjs";
export {
	CAMPAIGN_SCHEMA_VERSION,
	canonicalJson,
	canonicalManifestDigest,
	EXECUTION_PROFILES,
	findDependencyCycle,
	isKnownCampaignMajor,
	isSupportedCampaignVersion,
	KNOWN_CAMPAIGN_MAJORS,
	loadManifest,
	normalizeManifest,
	persistImmutableManifest,
	schemaMajor,
	validateManifest,
} from "./manifest.mjs";
export { contentDigest, isResolvableRef, resolveTaskFromOutcomes, resolveTaskOutcome } from "./outcome-resolver.mjs";
export {
	acquireCampaignOwnership,
	CHECKPOINT_SCHEMA_VERSION,
	campaignRuntimeDir,
	checkpointExists,
	defaultIsAlive,
	OWNERSHIP_SCHEMA_VERSION,
	PROJECTION_VERSION,
	readCheckpoint,
	releaseCampaignOwnership,
	writeCheckpoint,
} from "./ownership.mjs";
export {
	canDispatch,
	parseBudgetStrict,
	projectionSnapshot,
	projectQueueFromEvents,
	remainingBudget,
	validateDynamicDefinition,
} from "./projection.mjs";
export {
	isLegalTransition,
	isQueueState,
	legalTransitionsFrom,
	makeQueueItem,
	projectInitialQueue,
	QUEUE_STATES,
	TERMINAL_QUEUE_STATES,
	validateQueueItem,
} from "./queue.mjs";
export * from "./registries.mjs";
export {
	BUNDLE_SCHEMA_VERSION,
	buildAcceptanceBundle,
	buildCampaignReport,
	REPORT_GENERATOR_VERSION,
	REPORT_SCHEMA_VERSION,
	REVIEWER_VERDICTS,
	redactSecrets,
	renderCampaignReportMarkdown,
	renderReviewerPrompt,
	VISIBLE_CREDENTIAL_POLICIES,
	validateReviewerVerdict,
	visibleCredentialPolicy,
	withoutBundleDigest,
	withoutReportDigest,
} from "./report.mjs";
export { createCampaignScheduler, SCHEDULER_VERSION } from "./scheduler.mjs";
export { buildCommittedStream } from "./stream.mjs";
