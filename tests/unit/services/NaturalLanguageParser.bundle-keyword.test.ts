import { findBundleKeyword } from "../../../src/services/NaturalLanguageParser";

describe("findBundleKeyword", () => {
	const word = (input: string) => {
		const found = findBundleKeyword(input);
		return found && input.slice(found.start, found.end);
	};

	it("finds the plain word in any case on the title line", () => {
		expect(findBundleKeyword("Email Sam bundle")).toEqual({ start: 10, end: 16 });
		expect(word("Bundle email Sam")).toBe("Bundle");
		expect(word("Email BUNDLE Sam")).toBe("BUNDLE");
	});

	it("ignores tags, longer words, links and later lines", () => {
		expect(findBundleKeyword("Email Sam #bundle")).toBeNull();
		expect(findBundleKeyword("Email Sam bundled")).toBeNull();
		expect(findBundleKeyword("Read [[A bundle note]]")).toBeNull();
		expect(findBundleKeyword("Email Sam\nbundle")).toBeNull();
		expect(findBundleKeyword("Read [[A bundle note]] bundle")).toEqual({ start: 23, end: 29 });
	});
});
