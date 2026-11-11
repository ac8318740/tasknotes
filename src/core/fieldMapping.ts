import {
	coerceStatusFrontmatterValue,
	DEFAULT_DEPENDENCY_RELTYPE,
	extractDependencyUid,
	getFrontmatterTags as modelGetFrontmatterTags,
	isRecognizedProperty as modelIsRecognizedProperty,
	isValidDependencyRelType,
	lookupMappingKey as modelLookupMappingKey,
	mapTaskFromFrontmatter as modelMapTaskFromFrontmatter,
	mapTaskToFrontmatter as modelMapTaskToFrontmatter,
	normalizeDependencyEntry,
	normalizeDependencyList,
	normalizeFrontmatterTag,
	normalizePriorityConfigValue,
	normalizeStatusConfigValue,
	normalizeTitleValue,
	parseLinkToPath,
	serializeDependencies,
	validateFieldMapping as modelValidateFieldMapping,
	VALID_DEPENDENCY_RELTYPES,
} from "@tasknotes/model/mapping";
import { validateDateString } from "@tasknotes/model/date";
import type {
	FieldMapping,
	FieldMappingKey,
	PriorityConfig,
	StatusConfig,
	TaskInfo,
} from "../types";
import type { UserMappedField } from "../types/settings";
import {
	INHERITABLE_FIELDS,
	readInheritedMarker,
	type InheritanceProperties,
} from "./taskInheritance";
import {
	DEFAULT_BUNDLE_PROPERTY,
	DEFAULT_INHERITED_PROPERTY,
	DEFAULT_RECURRENCE_ORIGINAL_DATE_PROPERTY,
	DEFAULT_RECURRENCE_WINDOW_PROPERTY,
} from "./defaultFieldMapping";
import { normalizeStringArrayValue } from "./nullableListNormalization";

export {
	coerceStatusFrontmatterValue,
	DEFAULT_DEPENDENCY_RELTYPE,
	extractDependencyUid,
	isValidDependencyRelType,
	normalizeDependencyEntry,
	normalizeDependencyList,
	normalizeFrontmatterTag,
	normalizePriorityConfigValue,
	normalizeStatusConfigValue,
	normalizeTitleValue,
	parseLinkToPath,
	serializeDependencies,
	VALID_DEPENDENCY_RELTYPES,
};

// The shared model mapping does not know about `recurrenceOriginalDate`, `recurrenceWindow`,
// `bundle` or `inherited`, and settings saved before the fields existed do not contain
// them. These wrappers resolve the property names (falling back to the defaults) and handle the
// fields around the model functions.

type ResolvedFieldMapping = FieldMapping & {
	recurrenceOriginalDate: string;
	recurrenceWindow: string;
	bundle: string;
	inherited: string;
};

function withResolvedMapping(mapping: FieldMapping): ResolvedFieldMapping {
	if (
		typeof mapping.recurrenceOriginalDate === "string" &&
		typeof mapping.recurrenceWindow === "string" &&
		typeof mapping.bundle === "string" &&
		typeof mapping.inherited === "string"
	) {
		return mapping as ResolvedFieldMapping;
	}
	return {
		...mapping,
		recurrenceOriginalDate:
			mapping.recurrenceOriginalDate ?? DEFAULT_RECURRENCE_ORIGINAL_DATE_PROPERTY,
		recurrenceWindow: mapping.recurrenceWindow ?? DEFAULT_RECURRENCE_WINDOW_PROPERTY,
		bundle: mapping.bundle ?? DEFAULT_BUNDLE_PROPERTY,
		inherited: mapping.inherited ?? DEFAULT_INHERITED_PROPERTY,
	};
}

/** A recurrence window is a whole number of days or "month_end"; anything else means no window. */
export function normalizeRecurrenceWindow(value: unknown): number | "month_end" | undefined {
	if (value === "month_end") return value;
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Normalize a stored recurrence_original_date value. Only strict, real YYYY-MM-DD dates are
 * accepted; anything else is dropped so a malformed value can never become an occurrence identity.
 */
export function normalizeRecurrenceOriginalDate(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
	try {
		return validateDateString(trimmed);
	} catch {
		return undefined;
	}
}

/** Frontmatter property names used by task value inheritance. */
export function inheritanceProperties(mapping: FieldMapping): InheritanceProperties {
	const resolved = withResolvedMapping(mapping);
	return {
		priority: resolved.priority,
		contexts: resolved.contexts,
		bundle: resolved.bundle,
		inherited: resolved.inherited,
	};
}

export function toUserField(mapping: FieldMapping, internalName: FieldMappingKey): string {
	return withResolvedMapping(mapping)[internalName];
}

export function toUserFields(mapping: FieldMapping, internalFields: FieldMappingKey[]): string[] {
	const resolved = withResolvedMapping(mapping);
	return internalFields.map((field) => resolved[field]);
}

export function isPropertyForField(
	mapping: FieldMapping,
	propertyName: string,
	internalField: FieldMappingKey
): boolean {
	return withResolvedMapping(mapping)[internalField] === propertyName;
}

export function lookupMappingKey(
	mapping: FieldMapping,
	frontmatterPropertyName: string
): FieldMappingKey | null {
	return modelLookupMappingKey(withResolvedMapping(mapping), frontmatterPropertyName);
}

export function isRecognizedProperty(
	mapping: FieldMapping,
	frontmatterPropertyName: string
): boolean {
	return modelIsRecognizedProperty(withResolvedMapping(mapping), frontmatterPropertyName);
}

export function validateFieldMapping(mapping: FieldMapping): { valid: boolean; errors: string[] } {
	return modelValidateFieldMapping(withResolvedMapping(mapping));
}

// Backport model ea97ac46 (consumed by v5 in 02950c14) without taking
// rc.16's unrelated model/recurrence changes. Normalize read copies only;
// absent properties and custom fields must retain their original meaning.
function normalizeNullableLists(
	mapping: FieldMapping,
	frontmatter: Record<string, unknown> | undefined | null
): Record<string, unknown> | undefined | null {
	if (!frontmatter) return frontmatter;

	const normalized = { ...frontmatter };
	for (const property of [
		mapping.contexts,
		mapping.projects,
		mapping.icsEventId,
		mapping.googleCalendarMovedOriginalDates,
	]) {
		if (frontmatter[property] !== undefined) {
			normalized[property] = normalizeStringArrayValue(frontmatter[property]);
		}
	}
	if (frontmatter.tags !== undefined) normalized.tags = getFrontmatterTags(frontmatter.tags);
	return normalized;
}

export function getFrontmatterTags(value: unknown): string[] {
	return modelGetFrontmatterTags(Array.isArray(value) ? normalizeStringArrayValue(value) : value);
}

export function mapTaskFromFrontmatter(
	mapping: FieldMapping,
	frontmatter: Record<string, unknown> | undefined | null,
	filePath: string,
	storeTitleInFilename = false,
	userFields: readonly UserMappedField[] = [],
	statuses?: readonly StatusConfig[],
	priorities?: readonly PriorityConfig[]
): Partial<TaskInfo> {
	const resolved = withResolvedMapping(mapping);
	const mapped: Partial<TaskInfo> = modelMapTaskFromFrontmatter(
		resolved,
		normalizeNullableLists(resolved, frontmatter),
		filePath,
		storeTitleInFilename,
		userFields,
		statuses,
		priorities
	);
	const originalDate = normalizeRecurrenceOriginalDate(
		frontmatter?.[resolved.recurrenceOriginalDate]
	);
	if (originalDate) {
		mapped.recurrence_original_date = originalDate;
	}
	const window = normalizeRecurrenceWindow(frontmatter?.[resolved.recurrenceWindow]);
	if (window) {
		mapped.recurrence_window = window;
	}
	// Only `true` bundles a task; a hand-written `false` means the same as no value.
	if (frontmatter?.[resolved.bundle] === true) {
		mapped.bundle = true;
	}
	const marker = frontmatter ? readInheritedMarker(frontmatter, inheritanceProperties(resolved)) : [];
	const inherited = INHERITABLE_FIELDS.filter((field) => marker.includes(resolved[field]));
	if (inherited.length > 0) {
		mapped.inherited = inherited;
	}
	// The model reads unknown anchors as "scheduled"; keep the plugin's "period" anchor.
	if (frontmatter?.[resolved.recurrenceAnchor] === "period") {
		mapped.recurrence_anchor = frontmatter[resolved.recurrenceAnchor] as TaskInfo["recurrence_anchor"];
	}
	return mapped;
}

export function mapTaskToFrontmatter(
	mapping: FieldMapping,
	taskData: Partial<TaskInfo>,
	taskTag?: string,
	storeTitleInFilename = false,
	userFields: readonly UserMappedField[] = []
): Record<string, unknown> {
	const resolved = withResolvedMapping(mapping);
	const frontmatter = modelMapTaskToFrontmatter(
		resolved,
		{ ...taskData, tags: getFrontmatterTags(taskData.tags) },
		taskTag,
		storeTitleInFilename,
		userFields
	);
	const originalDate = normalizeRecurrenceOriginalDate(taskData.recurrence_original_date);
	if (originalDate) {
		frontmatter[resolved.recurrenceOriginalDate] = originalDate;
	}
	const window = normalizeRecurrenceWindow(taskData.recurrence_window);
	if (window) {
		frontmatter[resolved.recurrenceWindow] = window;
	}
	if (taskData.bundle === true) {
		frontmatter[resolved.bundle] = true;
	}
	return frontmatter;
}
