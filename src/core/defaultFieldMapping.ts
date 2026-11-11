import { DEFAULT_FIELD_MAPPING as MODEL_DEFAULT_FIELD_MAPPING } from "@tasknotes/model/mapping";
import type { FieldMapping } from "../types";

/** Default frontmatter property for a pending moved recurring occurrence's original rule date. */
export const DEFAULT_RECURRENCE_ORIGINAL_DATE_PROPERTY = "recurrence_original_date";

/** Default frontmatter property for the days each recurring occurrence stays open. */
export const DEFAULT_RECURRENCE_WINDOW_PROPERTY = "recurrence_window";

/** Default frontmatter property for whether a task may share a scheduled block with other tasks. */
export const DEFAULT_BUNDLE_PROPERTY = "bundle";

export const DEFAULT_FIELD_MAPPING: FieldMapping = {
	...MODEL_DEFAULT_FIELD_MAPPING,
	recurrenceOriginalDate: DEFAULT_RECURRENCE_ORIGINAL_DATE_PROPERTY,
	recurrenceWindow: DEFAULT_RECURRENCE_WINDOW_PROPERTY,
	bundle: DEFAULT_BUNDLE_PROPERTY,
};
