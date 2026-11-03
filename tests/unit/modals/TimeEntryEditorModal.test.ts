import { setEntryTimes, TimeEntryEditorModal } from "../../../src/modals/TimeEntryEditorModal";
import { createTaskModalMarkdownEditor } from "../../../src/modals/taskModalEditorAdapter";
import { PluginFactory, TaskFactory, TimeEntryFactory } from "../../helpers/mock-factories";

jest.mock("../../../src/modals/taskModalEditorAdapter", () => ({
	createTaskModalMarkdownEditor: jest.fn(),
}));

describe("TimeEntryEditorModal", () => {
	const createTaskModalMarkdownEditorMock = createTaskModalMarkdownEditor as jest.MockedFunction<
		typeof createTaskModalMarkdownEditor
	>;

	function focusFirstDescriptionEditor(modal: TimeEntryEditorModal) {
		const textarea = modal.contentEl.querySelector<HTMLTextAreaElement>(
			".time-entry-editor-modal__description-editor-fallback"
		);
		expect(textarea).not.toBeNull();

		textarea?.dispatchEvent(new Event("focus"));
		expect(createTaskModalMarkdownEditorMock).toHaveBeenCalled();

		return createTaskModalMarkdownEditorMock.mock.calls[
			createTaskModalMarkdownEditorMock.mock.calls.length - 1
		][2];
	}

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("saves description updates from the lightweight description field", () => {
		const plugin = PluginFactory.createMockPlugin();
		const task = TaskFactory.createTask({
			timeEntries: [TimeEntryFactory.createEntry({ description: "Initial work" })],
		});
		const onSave = jest.fn();

		const modal = new TimeEntryEditorModal(plugin.app as any, plugin as any, task, onSave);
		modal.onOpen();

		const textarea = modal.contentEl.querySelector<HTMLTextAreaElement>(
			".time-entry-editor-modal__description-editor-fallback"
		);
		expect(textarea).not.toBeNull();
		expect(createTaskModalMarkdownEditorMock).not.toHaveBeenCalled();

		if (textarea) {
			textarea.value = "Worked on #learning";
			textarea.dispatchEvent(new Event("input"));
		}
		(modal as any).save();

		expect(onSave).toHaveBeenCalledWith([
			expect.objectContaining({ description: "Worked on #learning" }),
		]);
	});

	it("saves description updates coming from the lazily hydrated markdown editor", () => {
		const plugin = PluginFactory.createMockPlugin();
		const task = TaskFactory.createTask({
			timeEntries: [TimeEntryFactory.createEntry({ description: "Initial work" })],
		});
		const onSave = jest.fn();

		createTaskModalMarkdownEditorMock.mockReturnValue({
			destroy: jest.fn(),
		} as any);

		const modal = new TimeEntryEditorModal(plugin.app as any, plugin as any, task, onSave);
		modal.onOpen();

		expect(createTaskModalMarkdownEditorMock).not.toHaveBeenCalled();
		const editorOptions = focusFirstDescriptionEditor(modal);
		expect(createTaskModalMarkdownEditorMock).toHaveBeenCalledTimes(1);

		editorOptions.onChange("Worked on #learning");
		(modal as any).save();

		expect(onSave).toHaveBeenCalledWith([
			expect.objectContaining({ description: "Worked on #learning" }),
		]);
	});

	it("closes the modal when Escape is pressed inside the markdown editor", () => {
		const plugin = PluginFactory.createMockPlugin();
		const task = TaskFactory.createTask({
			timeEntries: [TimeEntryFactory.createEntry()],
		});

		createTaskModalMarkdownEditorMock.mockReturnValue({
			destroy: jest.fn(),
		} as any);

		const modal = new TimeEntryEditorModal(plugin.app as any, plugin as any, task, jest.fn());
		const closeSpy = jest.spyOn(modal, "close").mockImplementation(jest.fn());
		modal.onOpen();

		const editorOptions = focusFirstDescriptionEditor(modal);
		editorOptions.onEscape();

		expect(closeSpy).toHaveBeenCalledTimes(1);
	});

	it("destroys markdown editors before rerendering and when closing", () => {
		const plugin = PluginFactory.createMockPlugin();
		const task = TaskFactory.createTask({
			timeEntries: [TimeEntryFactory.createEntry()],
		});

		const firstEditor = { destroy: jest.fn() } as any;
		const secondEditor = { destroy: jest.fn() } as any;
		const thirdEditor = { destroy: jest.fn() } as any;

		createTaskModalMarkdownEditorMock
			.mockReturnValueOnce(firstEditor)
			.mockReturnValueOnce(secondEditor);

		const modal = new TimeEntryEditorModal(plugin.app as any, plugin as any, task, jest.fn());
		modal.onOpen();
		focusFirstDescriptionEditor(modal);

		(modal as any).addNewEntry();

		expect(firstEditor.destroy).toHaveBeenCalledTimes(1);
		expect(createTaskModalMarkdownEditorMock).toHaveBeenCalledTimes(1);

		focusFirstDescriptionEditor(modal);

		modal.onClose();

		expect(secondEditor.destroy).toHaveBeenCalledTimes(1);
		expect(createTaskModalMarkdownEditorMock).toHaveBeenCalledTimes(2);
	});

	it("shows and saves an entry logged without clock times as its duration", () => {
		const plugin = PluginFactory.createMockPlugin();
		const task = TaskFactory.createTask({
			timeEntries: [{ startTime: "2026-11-02", endTime: "2026-11-02", minutes: 60 }],
		});
		const onSave = jest.fn();

		const modal = new TimeEntryEditorModal(plugin.app as any, plugin as any, task, onSave);
		modal.onOpen();

		const inputs = modal.contentEl.querySelectorAll<HTMLInputElement>(".time-entry-editor-modal__entry input");
		expect([...inputs].map((input) => input.value)).toEqual(["2026-11-02", "", "", "60"]);
		(modal as any).save();
		expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ minutes: 60 })]);
	});

	it("groups a recurring task's entries by occurrence", () => {
		const plugin = PluginFactory.createMockPlugin();
		const task = TaskFactory.createTask({
			recurrence: "DTSTART:20261005;FREQ=WEEKLY;BYDAY=MO",
			timeEntries: [
				{ startTime: "2026-11-02", endTime: "2026-11-02", minutes: 60, occurrence: "2026-11-02" },
				{ startTime: "2026-10-27", endTime: "2026-10-27", minutes: 30, occurrence: "2026-10-26" },
			],
		});

		const modal = new TimeEntryEditorModal(plugin.app as any, plugin as any, task, jest.fn());
		modal.onOpen();

		const groups = modal.contentEl.querySelectorAll(".time-entry-editor-modal__group");
		expect(groups).toHaveLength(2);
		expect(groups[0].querySelectorAll(".time-entry-editor-modal__entry")).toHaveLength(1);
	});
});

describe("setEntryTimes", () => {
	it("stores only a length, on the day's local midnight, when there is no start time", () => {
		const entry = { startTime: "2026-11-02T09:00:00Z", endTime: "2026-11-02T10:00:00Z" };
		setEntryTimes(entry, "2026-11-03", "", 45);
		expect(entry).toEqual({ startTime: "2026-11-03T00:00", endTime: "2026-11-03T00:00", minutes: 45 });
	});

	it("keeps lengths of a day or more, and crosses midnight", () => {
		const entry: any = { startTime: "2026-11-02T00:00", endTime: "2026-11-02T00:00", minutes: 45 };
		setEntryTimes(entry, "2026-11-02", "23:30", 1500);
		expect(entry.minutes).toBeUndefined();
		expect((new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime()) / 60000).toBe(1500);
	});

	it("leaves the end empty for a running entry", () => {
		const entry: any = { startTime: "2026-11-02T00:00", endTime: "2026-11-02T00:00", minutes: 45 };
		setEntryTimes(entry, "2026-11-02", "09:00", null);
		expect(entry.endTime).toBeUndefined();
	});
});
