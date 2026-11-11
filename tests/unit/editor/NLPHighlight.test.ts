import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { NaturalLanguageParserCore, type ParsedSpan } from "tasknotes-nlp-core";
import {
	createNLPHighlight,
	getNLPParseInput,
	releaseHighlightAtCursor,
} from "../../../src/editor/NLPHighlight";

// Recognises "december" as a date wherever it appears, so masking is observable.
const getSpans = (text: string): ParsedSpan[] =>
	Array.from(text.matchAll(/december/gi), (match) => ({
		kind: "due" as const,
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
		text: match[0],
	}));

function editor(doc: string, cursor = doc.length) {
	const view = {
		state: EditorState.create({
			doc,
			selection: EditorSelection.cursor(cursor),
			extensions: createNLPHighlight(getSpans),
		}),
		dispatch(spec: TransactionSpec) {
			view.state = view.state.update(spec).state;
		},
	};
	return view;
}

describe("NLPHighlight backspace release", () => {
	it("releases the highlight ending at the cursor without deleting text", () => {
		const view = editor("by December");

		expect(releaseHighlightAtCursor(view, getSpans)).toBe(true);

		expect(view.state.doc.toString()).toBe("by December");
		expect(getSpans(getNLPParseInput(view.state).text)).toEqual([]);
	});

	it("lets Backspace delete normally once the highlight is released", () => {
		const view = editor("by December");
		releaseHighlightAtCursor(view, getSpans);

		expect(releaseHighlightAtCursor(view, getSpans)).toBe(false);
	});

	it("does nothing when the cursor is not at the end of a highlight", () => {
		expect(releaseHighlightAtCursor(editor("by December", 5), getSpans)).toBe(false);
		expect(releaseHighlightAtCursor(editor("by December groceries"), getSpans)).toBe(false);
	});

	it("keeps a released word plain while the rest of the input is typed", () => {
		const view = editor("by December");
		releaseHighlightAtCursor(view, getSpans);

		view.dispatch({ changes: { from: 11, insert: " groceries" } });
		view.dispatch({ changes: { from: 0, insert: "Buy " } });

		const { text, restore } = getNLPParseInput(view.state);
		expect(getSpans(text)).toEqual([]);
		expect(text).toHaveLength(view.state.doc.length);
		expect(restore(text)).toBe("Buy by December groceries");
	});

	it("recognises the word again once it is edited", () => {
		const view = editor("by December");
		releaseHighlightAtCursor(view, getSpans);

		view.dispatch({ changes: { from: 10, to: 11 } });
		view.dispatch({ changes: { from: 10, insert: "r" } });

		expect(getSpans(getNLPParseInput(view.state).text)).toHaveLength(1);
	});

	it("keeps released text in the title and out of parsed values", () => {
		const view = editor("Buy milk #errands");
		const tagSpans = (text: string) => parser.parseInputWithSpans(text).spans;
		const parser = new NaturalLanguageParserCore();

		expect(releaseHighlightAtCursor(view, tagSpans)).toBe(true);

		const { text, restore } = getNLPParseInput(view.state);
		const parsed = parser.parseInput(text);
		expect(parsed.tags).toEqual([]);
		expect(restore(parsed.title)).toBe("Buy milk #errands");
	});
});
