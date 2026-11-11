/**
 * Parents pass priority, contexts and bundle down to descendants that have no value of their own.
 * The values are copied into each descendant's frontmatter so Bases and other tools can read them,
 * and the copied property names are listed in the `inherited` marker.
 */

export const INHERITABLE_FIELDS = ["priority", "contexts", "bundle"] as const;
export type InheritableField = (typeof INHERITABLE_FIELDS)[number];
export type InheritedValue = string | string[] | true;
export type InheritedValues = Partial<Record<InheritableField, InheritedValue>>;
/** Copied values as last seen in a file, which may have been edited by hand. */
export type SeenValues = Partial<Record<InheritableField, unknown>>;

/** Frontmatter property names, already resolved through the field mapping. */
export type InheritanceProperties = Record<InheritableField | "inherited", string>;

type Frontmatter = Record<string, unknown>;

function contextsList(value: unknown): string[] {
	const values = Array.isArray(value) ? value : [value];
	return values.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** The value a task passes down for a field, if any. */
function passedValue(field: InheritableField, value: unknown): InheritedValue | undefined {
	switch (field) {
		case "priority":
			return typeof value === "string" && value.trim() !== "" && value !== "none"
				? value
				: undefined;
		case "contexts": {
			const contexts = contextsList(value);
			return contexts.length > 0 ? contexts : undefined;
		}
		case "bundle":
			return value === true ? true : undefined;
	}
}

/** Whether a task's own value blocks inheritance. A hand-written `bundle: false` does. */
function hasOwnValue(field: InheritableField, value: unknown): boolean {
	return field === "bundle" ? typeof value === "boolean" : passedValue(field, value) !== undefined;
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function readInheritedMarker(frontmatter: Frontmatter, props: InheritanceProperties): string[] {
	const marker = frontmatter[props.inherited];
	const values = Array.isArray(marker) ? marker : marker == null ? [] : [marker];
	return values.filter((value): value is string => typeof value === "string");
}

function writeMarker(frontmatter: Frontmatter, props: InheritanceProperties, marked: Set<string>): void {
	const ordered = INHERITABLE_FIELDS.map((field) => props[field]).filter((prop) => marked.has(prop));
	if (ordered.length > 0) frontmatter[props.inherited] = ordered;
	else delete frontmatter[props.inherited];
}

/**
 * Values a task inherits. Ancestors are walked breadth first through their parent links: the
 * nearest ancestor with its own value wins, and at equal distance the first listed parent wins.
 * An ancestor's copied values are skipped, so a stale copy never passes further down.
 */
export function findInheritedValues(
	path: string,
	props: InheritanceProperties,
	getFrontmatter: (path: string) => Frontmatter | undefined,
	getParents: (path: string) => readonly string[]
): InheritedValues {
	const result: InheritedValues = {};
	const visited = new Set([path]);
	let level = [...getParents(path)];
	while (level.length > 0 && Object.keys(result).length < INHERITABLE_FIELDS.length) {
		const found: InheritedValues = {};
		const next: string[] = [];
		for (const ancestor of level) {
			if (visited.has(ancestor)) continue;
			visited.add(ancestor);
			next.push(...getParents(ancestor));
			const frontmatter = getFrontmatter(ancestor);
			if (!frontmatter) continue;
			const marked = readInheritedMarker(frontmatter, props);
			for (const field of INHERITABLE_FIELDS) {
				if (field in result || field in found || marked.includes(props[field])) continue;
				const value = passedValue(field, frontmatter[props[field]]);
				if (value !== undefined) found[field] = value;
			}
		}
		Object.assign(result, found);
		level = next;
	}
	return result;
}

/**
 * Brings a task's copied values in line with what it inherits, editing `frontmatter` in place.
 * `previous` holds the copied values seen last time; a copied value that has since changed to
 * something other than the inherited value was edited by hand and becomes the task's own value.
 * Returns whether anything changed.
 */
export function reconcileInheritedValues(
	frontmatter: Frontmatter,
	inherited: InheritedValues,
	props: InheritanceProperties,
	previous?: SeenValues
): boolean {
	const before = JSON.stringify(frontmatter);
	const marked = new Set(readInheritedMarker(frontmatter, props));
	for (const field of INHERITABLE_FIELDS) {
		const prop = props[field];
		const current = frontmatter[prop];
		if (
			marked.has(prop) &&
			previous &&
			field in previous &&
			!sameValue(current, previous[field]) &&
			!sameValue(current, inherited[field])
		) {
			marked.delete(prop);
		}
		if (!marked.has(prop) && hasOwnValue(field, current)) continue;
		const value = inherited[field];
		if (value !== undefined) {
			frontmatter[prop] = Array.isArray(value) ? [...(value as unknown[])] : value;
			marked.add(prop);
		} else if (marked.has(prop)) {
			delete frontmatter[prop];
			marked.delete(prop);
		}
	}
	writeMarker(frontmatter, props, marked);
	return JSON.stringify(frontmatter) !== before;
}

/** The copied values currently in a task's frontmatter. */
export function copiedValues(frontmatter: Frontmatter, props: InheritanceProperties): SeenValues {
	const marked = new Set(readInheritedMarker(frontmatter, props));
	const values: SeenValues = {};
	for (const field of INHERITABLE_FIELDS) {
		if (marked.has(props[field])) values[field] = frontmatter[props[field]];
	}
	return values;
}

/**
 * A value set through TaskNotes becomes the task's own value. Turning off an inherited bundle
 * writes `bundle: false`, because no value at all would inherit it again.
 */
export function claimEditedValues(
	frontmatter: Frontmatter,
	edited: readonly InheritableField[],
	props: InheritanceProperties
): void {
	const marked = new Set(readInheritedMarker(frontmatter, props));
	for (const field of edited) {
		const prop = props[field];
		if (!marked.delete(prop)) continue;
		if (field === "bundle" && frontmatter[prop] !== true) frontmatter[prop] = false;
	}
	if (marked.size > 0 || props.inherited in frontmatter) writeMarker(frontmatter, props, marked);
}
