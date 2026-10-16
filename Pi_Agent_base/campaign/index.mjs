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
	buildCodeRepairManifest,
	CODE_REPAIR_ACTION_REF,
	createCodeRepairAdapter,
	createCodeRepairJudge,
} from "../execution/adapters/code-repair-adapter.mjs";
export {
	createFixtureAdapterContract,
	FIXTURE_ADAPTER_ACTION_REF,
	readFixtureState,
} from "../execution/adapters/fixture-adapter.mjs";
export {
	createWorkspaceScriptRegistration,
	WORKSPACE_ADAPTER_SCRIPT_ID,
	workspaceStateFile,
} from "../execution/adapters/script-workspace-adapter.mjs";
export {
	buildDataRepairManifest,
	createDataRepairJudge,
	createStructuredDataAdapter,
	DATA_REPAIR_ACTION_REF,
} from "../execution/adapters/structured-data-adapter.mjs";
export { createBrokerWorker } from "../execution/broker-worker.mjs";
export {
	buildCampaignLearningBridge,
	C6_LEARNING_VERSION,
	compileExperienceFromProofs,
	createCampaignLearningStore,
	loadAuthoritativeExperiences,
	rebuildExperienceStore,
	replayCommittedOutcome,
	routeBeforeModel,
	runCampaignLearningStep,
} from "../memory/c6-learning.mjs";
export {
	OBSERVATION_COMMAND_VERSION,
	observationConfigFromEnv,
	runObservationCommand,
} from "../observation/observation-command.mjs";
export { createObservationServer, OBSERVATION_SERVER_VERSION } from "../observation/observation-server.mjs";
export {
	buildObservationView,
	escapeForScriptJson,
	escapeHtml,
	OBSERVATION_LIMITS,
	OBSERVATION_VIEW_VERSION,
	renderObservationHtml,
	summarizeObservationView,
} from "../observation/observation-view.mjs";
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
} from "../observation/report.mjs";
export { parseArgs, REPORT_ENTRY_VERSION, runReportExport } from "../observation/report-entry.mjs";
export {
	buildReportInputs,
	countCommitted,
	DEFAULT_LIMITS,
	deriveIntegrity,
	generateCampaignArtifacts,
	REPORT_EXPORT_VERSION,
	validateAcceptanceBundle,
} from "../observation/report-export.mjs";
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
} from "../verification/aggregate.mjs";
export { createHostOracle } from "../verification/host-oracle.mjs";
export {
	contentDigest,
	isResolvableRef,
	resolveTaskFromOutcomes,
	resolveTaskOutcome,
} from "../verification/outcome-resolver.mjs";
export { REGISTERED_TEST_VERSION, runRegisteredTest } from "../verification/registered-test.mjs";
export {
	assembleCampaignHost,
	buildC3FixtureManifest,
	createProductSink,
	ENTRY_VERSION,
	runCampaignHost,
	summarize,
} from "./c3-entry.mjs";
export {
	C5_ENTRY_VERSION,
	campaignGateExtensionFactory,
	createHostSessionController,
	runCampaignFromConfig,
} from "./c5-entry.mjs";
// --- C6 -------------------------------------------------------------------
export {
	buildMeasurement,
	C6_ENTRY_VERSION,
	createCompositeWorker,
	createDecisionBuffer,
	parseC6Args,
	runC6FromConfig,
	stageHostHandoff,
} from "./c6-entry.mjs";
export {
	createDecisionCaptureTool,
	createModelPlan,
	createModelWorker,
	MODEL_WORKER_VERSION,
} from "./c6-model-worker.mjs";
export {
	classifyStopReason,
	REQUEST_PHASE,
	reservedSeedForTask,
	summarizeRequestLedger,
	validateCommittedRecord,
	validateReservation,
} from "./c6-request-lifecycle.mjs";
export { readRunnerManifest, runBoundedAttempts } from "./c6-runner.mjs";
export {
	AEGIS_OBSERVER_PATH,
	buildModelRuntime,
	createCampaignSdkRuntime,
	SDK_RUNTIME_VERSION,
} from "./c6-sdk-runtime.mjs";
export { createToolLedger, normalizeUsage, TOOL_LEDGER_VERSION } from "./c6-tool-ledger.mjs";
export {
	CONFIG_SCHEMA_VERSION,
	CONFIG_SCHEMA_VERSION_V11,
	KNOWN_CONFIG_V11_KEYS,
	loadCampaignConfig,
} from "./campaign-config.mjs";
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
export { buildBudgetLedger, createCampaignHost, ensureWorkspace, HOST_VERSION } from "./host.mjs";
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
	describeCredentialRef,
	isLoopbackBaseUrl,
	KNOWN_PROVIDERS,
	PROVIDER_CONFIG_VERSION,
	resolveProviderConfig,
} from "./provider-config.mjs";
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
export { createCampaignScheduler, SCHEDULER_VERSION } from "./scheduler.mjs";
export { buildCommittedStream } from "./stream.mjs";
