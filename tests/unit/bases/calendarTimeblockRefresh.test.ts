import { BasesViewBase } from "../../../src/bases/BasesViewBase";
import { CalendarView } from "../../../src/bases/CalendarView";

jest.mock("obsidian-daily-notes-interface", () => ({
	...jest.requireActual("obsidian-daily-notes-interface"),
	getDateFromFile: (file: { basename: string }) =>
		/^\d{4}-\d{2}-\d{2}$/.test(file.basename) ? {} : null,
}));

describe("CalendarView refetches timeblocks after outside daily-note edits", () => {
	afterEach(() => {
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it("refetches once per timeblock change, ignores other edits, and stops on unload", () => {
		jest.useFakeTimers();
		jest.spyOn(BasesViewBase.prototype, "onload").mockImplementation(() => {});
		let onChanged: (file: unknown, data: string, cache: unknown) => void = () => {};
		const cleanups: Array<() => void> = [];
		const refetchEvents = jest.fn();
		const root = document.createElement("div");
		document.body.appendChild(root);
		const view = Object.assign(Object.create(CalendarView.prototype), {
			plugin: {
				emitter: { on: jest.fn(), offref: jest.fn() },
				app: { metadataCache: { on: (_name: string, cb: typeof onChanged) => (onChanged = cb) } },
			},
			rootElement: root,
			viewOptions: { showTimeblocks: true },
			readViewOptions: jest.fn(),
			getConfigSnapshot: jest.fn(),
			getDataSignature: jest.fn(),
			getControllerViewName: jest.fn(),
			register: (cleanup: () => void) => cleanups.push(cleanup),
			registerEvent: jest.fn(),
			refetchEvents,
			render: jest.fn(),
		});
		view.onload();

		const daily = { path: "2026-11-02.md", basename: "2026-11-02" };
		const withBlocks = (blocks: unknown[]) => ({ frontmatter: { timeblocks: blocks } });

		onChanged(daily, "", withBlocks([{ id: "a" }]));
		onChanged(daily, "", withBlocks([{ id: "a", pinned: true }]));
		jest.advanceTimersByTime(300);
		expect(refetchEvents).toHaveBeenCalledTimes(1);

		onChanged(daily, "", withBlocks([{ id: "a", pinned: true }]));
		onChanged({ path: "Notes/Idea.md", basename: "Idea" }, "", withBlocks([{ id: "b" }]));
		jest.advanceTimersByTime(300);
		expect(refetchEvents).toHaveBeenCalledTimes(1);

		onChanged(daily, "", { frontmatter: {} });
		cleanups.forEach((cleanup) => cleanup());
		jest.advanceTimersByTime(300);
		expect(refetchEvents).toHaveBeenCalledTimes(1);
		root.remove();
	});
});
