import {
	claimEditedValues,
	copiedValues,
	findInheritedValues,
	reconcileInheritedValues,
	type InheritanceProperties,
} from "../../../src/core/taskInheritance";

const props: InheritanceProperties = {
	priority: "priority",
	contexts: "contexts",
	bundle: "bundle",
	inherited: "inherited",
};

function graph(files: Record<string, { fm: Record<string, unknown>; parents?: string[] }>) {
	return {
		get: (path: string) => files[path]?.fm,
		parents: (path: string) => files[path]?.parents ?? [],
	};
}

describe("findInheritedValues", () => {
	it("passes a parent's own value further down, ahead of values from further up", () => {
		const g = graph({
			a: { fm: { priority: "high", contexts: ["@desk"] } },
			b: { fm: { priority: "low" }, parents: ["a"] },
			c: { fm: {}, parents: ["b"] },
		});
		expect(findInheritedValues("c", props, g.get, g.parents)).toEqual({
			priority: "low",
			contexts: ["@desk"],
		});
	});

	it("skips an ancestor's copied values and looks further up", () => {
		const g = graph({
			a: { fm: { priority: "high" } },
			b: { fm: { priority: "stale", inherited: ["priority"] }, parents: ["a"] },
			c: { fm: {}, parents: ["b"] },
		});
		expect(findInheritedValues("c", props, g.get, g.parents)).toEqual({ priority: "high" });
	});

	it("prefers the nearest ancestor, then the first listed parent", () => {
		const g = graph({
			far: { fm: { priority: "high", bundle: true } },
			first: { fm: { priority: "low" }, parents: ["far"] },
			second: { fm: { priority: "normal", contexts: "@home" } },
			child: { fm: {}, parents: ["first", "second"] },
		});
		expect(findInheritedValues("child", props, g.get, g.parents)).toEqual({
			priority: "low",
			contexts: ["@home"],
			bundle: true,
		});
	});

	it("passes nothing for none, empty contexts or bundle false, and survives cycles", () => {
		const g = graph({
			a: { fm: { priority: "none", contexts: [], bundle: false }, parents: ["b"] },
			b: { fm: {}, parents: ["a"] },
		});
		expect(findInheritedValues("a", props, g.get, g.parents)).toEqual({});
	});
});

describe("reconcileInheritedValues", () => {
	it("copies inherited values into unset fields and marks them", () => {
		const fm: Record<string, unknown> = { priority: "none" };
		expect(reconcileInheritedValues(fm, { priority: "high", bundle: true }, props)).toBe(true);
		expect(fm).toEqual({ priority: "high", bundle: true, inherited: ["priority", "bundle"] });
		expect(reconcileInheritedValues(fm, { priority: "high", bundle: true }, props)).toBe(false);
	});

	it("keeps the task's own values, including a hand-written bundle false", () => {
		const fm: Record<string, unknown> = { priority: "low", bundle: false };
		expect(reconcileInheritedValues(fm, { priority: "high", bundle: true }, props)).toBe(false);
	});

	it("refreshes stale copies and removes copies nothing passes down any more", () => {
		const fm: Record<string, unknown> = {
			priority: "high",
			contexts: ["@desk"],
			inherited: ["priority", "contexts"],
		};
		reconcileInheritedValues(fm, { priority: "low" }, props);
		expect(fm).toEqual({ priority: "low", inherited: ["priority"] });
		reconcileInheritedValues(fm, {}, props);
		expect(fm).toEqual({});
	});

	it("treats a copy changed by hand as the task's own value", () => {
		const fm: Record<string, unknown> = { priority: "low", inherited: ["priority"] };
		reconcileInheritedValues(fm, { priority: "high" }, props, { priority: "high" });
		expect(fm).toEqual({ priority: "low" });
	});

	it("keeps a copy that another device already refreshed", () => {
		const fm: Record<string, unknown> = { priority: "low", inherited: ["priority"] };
		reconcileInheritedValues(fm, { priority: "low" }, props, { priority: "high" });
		expect(fm).toEqual({ priority: "low", inherited: ["priority"] });
	});

	it("uses the mapped property names", () => {
		const mapped = { ...props, priority: "prio", inherited: "copied" };
		const fm: Record<string, unknown> = {};
		reconcileInheritedValues(fm, { priority: "high" }, mapped);
		expect(fm).toEqual({ prio: "high", copied: ["prio"] });
		expect(copiedValues(fm, mapped)).toEqual({ priority: "high" });
	});
});

describe("claimEditedValues", () => {
	it("unmarks edited values and writes bundle false when an inherited bundle is turned off", () => {
		const fm: Record<string, unknown> = {
			priority: "low",
			contexts: ["@desk"],
			inherited: ["priority", "contexts", "bundle"],
		};
		claimEditedValues(fm, ["priority", "bundle"], props);
		expect(fm).toEqual({ priority: "low", contexts: ["@desk"], bundle: false, inherited: ["contexts"] });
	});

	it("leaves tasks without a marker untouched", () => {
		const fm: Record<string, unknown> = { priority: "low" };
		claimEditedValues(fm, ["priority", "bundle"], props);
		expect(fm).toEqual({ priority: "low" });
	});
});
