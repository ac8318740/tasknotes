import {
	type ChangeSet,
	type EditorState,
	type Extension,
	Prec,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
	keymap,
} from "@codemirror/view";
import type { ParsedSpan } from "tasknotes-nlp-core";

interface Range {
	from: number;
	to: number;
}

const releaseRange = StateEffect.define<Range>();

/**
 * Ranges the user turned back into plain text with Backspace. A range is dropped
 * once that word is edited, so retyping it lets the parser recognise it again.
 */
const releasedRanges = StateField.define<Range[]>({
	create: () => [],
	update(ranges, tr) {
		let next = ranges;
		if (tr.docChanged) {
			next = ranges.filter((range) => !isEdited(range, tr.changes));
			next = next.map((range) => ({
				from: tr.changes.mapPos(range.from, 1),
				to: tr.changes.mapPos(range.to, -1),
			}));
		}
		for (const effect of tr.effects) {
			if (effect.is(releaseRange)) next = [...next, effect.value];
		}
		return next;
	},
});

function isEdited(range: Range, changes: ChangeSet): boolean {
	let edited = false;
	changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (fromA > range.to || toA < range.from) return;
		const text = inserted.toString();
		// Typing a space or newline next to the word leaves the word itself unchanged.
		const besideEnd = fromA === toA && fromA === range.to && /^\s/.test(text);
		const besideStart = fromA === toA && fromA === range.from && /\s$/.test(text);
		if (!besideEnd && !besideStart) edited = true;
	});
	return edited;
}

// Letters from a rare script stand in for released text: the parser reads them as an
// ordinary word it cannot match, and the same length keeps every offset unchanged.
const MASK_BASE = 0xa500;

/**
 * Returns the editor text with released ranges hidden from the parser, and a function
 * that puts the original words back into parsed text such as the title.
 */
export function getNLPParseInput(state: EditorState): {
	text: string;
	restore: (parsed: string) => string;
} {
	const doc = state.doc.toString();
	const ranges = [...(state.field(releasedRanges, false) ?? [])].sort((a, b) => a.from - b.from);
	if (ranges.length === 0) return { text: doc, restore: (parsed) => parsed };

	let text = "";
	let last = 0;
	const originals = new Map<string, string>();
	ranges.forEach((range, index) => {
		const mask = String.fromCharCode(MASK_BASE + index).repeat(range.to - range.from);
		originals.set(mask, doc.slice(range.from, range.to));
		text += doc.slice(last, range.from) + mask;
		last = range.to;
	});
	text += doc.slice(last);

	return {
		text,
		restore: (parsed) => {
			let result = parsed;
			for (const [mask, original] of originals) result = result.split(mask).join(original);
			return result;
		},
	};
}

/**
 * Releases the highlight that ends at the cursor, if any. Returns whether it did,
 * so Backspace deletes nothing when it releases a highlight.
 */
export function releaseHighlightAtCursor(
	view: Pick<EditorView, "state" | "dispatch">,
	getSpans: (text: string) => ParsedSpan[]
): boolean {
	const { state } = view;
	const selection = state.selection.main;
	if (!selection.empty) return false;

	let spans: ParsedSpan[];
	try {
		spans = getSpans(getNLPParseInput(state).text);
	} catch {
		return false;
	}
	const span = spans.find(
		(candidate) => candidate.end === selection.head && candidate.end > candidate.start
	);
	if (!span) return false;

	view.dispatch({ effects: releaseRange.of({ from: span.start, to: span.end }) });
	return true;
}

/**
 * Marks the parts of natural language input that the parser recognised, such as
 * dates, tags and recurrence, with a class per kind (`tn-nlp-highlight--due`).
 * Backspace straight after a highlight turns it back into plain text and calls
 * `onRelease`, since the text itself has not changed.
 */
export function createNLPHighlight(
	getSpans: (text: string) => ParsedSpan[],
	onRelease?: () => void
): Extension {
	const build = (view: EditorView): DecorationSet => {
		const builder = new RangeSetBuilder<Decoration>();
		const { text } = getNLPParseInput(view.state);
		if (!text.trim()) return builder.finish();

		let spans: ParsedSpan[];
		try {
			spans = getSpans(text);
		} catch {
			return builder.finish();
		}

		let lastEnd = 0;
		for (const span of [...spans].sort((a, b) => a.start - b.start)) {
			// RangeSetBuilder needs sorted, non-overlapping ranges here.
			if (span.start < lastEnd || span.end <= span.start || span.end > text.length) continue;
			builder.add(
				span.start,
				span.end,
				Decoration.mark({
					class: `tn-nlp-highlight tn-nlp-highlight--${span.kind}`,
				})
			);
			lastEnd = span.end;
		}
		return builder.finish();
	};

	return [
		releasedRanges,
		Prec.highest(
			keymap.of([
				{
					key: "Backspace",
					run: (view) => {
						if (!releaseHighlightAtCursor(view, getSpans)) return false;
						onRelease?.();
						return true;
					},
				},
			])
		),
		ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;

				constructor(view: EditorView) {
					this.decorations = build(view);
				}

				update(update: ViewUpdate) {
					const released = update.transactions.some((tr) =>
						tr.effects.some((effect) => effect.is(releaseRange))
					);
					if (update.docChanged || released) this.decorations = build(update.view);
				}
			},
			{ decorations: (plugin) => plugin.decorations }
		),
	];
}
