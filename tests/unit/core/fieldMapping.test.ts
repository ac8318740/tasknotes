import {
	mapTaskFromFrontmatter,
	mapTaskToFrontmatter,
	validateFieldMapping,
} from "../../../src/core/fieldMapping";
import { DEFAULT_FIELD_MAPPING } from "../../../src/settings/defaults";

describe("core/fieldMapping", () => {
	it("maps frontmatter into task fields without a FieldMapper instance", () => {
		const mapped = mapTaskFromFrontmatter(
			DEFAULT_FIELD_MAPPING,
			{
				title: "Mapped title",
				status: true,
				contexts: "work",
				projects: ["alpha"],
				attachments: "[[Attachments/receipt.jpg]]",
				recurrence_anchor: "completion",
				complete_instances: ["2026-03-01", 123, "2026-03-02"],
				tags: ["task", "archived"],
			},
			"Tasks/Mapped title.md",
			true
		);

		expect(mapped).toMatchObject({
			title: "Mapped title",
			status: "true",
			contexts: ["work"],
			projects: ["alpha"],
			attachments: ["[[Attachments/receipt.jpg]]"],
			recurrence_anchor: "completion",
			complete_instances: ["2026-03-01", "2026-03-02"],
			tags: ["task", "archived"],
			archived: true,
			path: "Tasks/Mapped title.md",
		});
	});

	it("maps task fields back to frontmatter with serialized dependency data", () => {
		const frontmatter = mapTaskToFrontmatter(
			DEFAULT_FIELD_MAPPING,
			{
				title: "Task",
				status: "open",
				blockedBy: [{ uid: "[[Other Task]]", reltype: "FINISHTOSTART" }],
				recurrence_anchor: "scheduled",
				attachments: ["[[Attachments/receipt.jpg]]"],
				tags: ["alpha"],
				archived: true,
			},
			"task"
		);

		expect(frontmatter.title).toBe("Task");
		expect(frontmatter.status).toBe("open");
		expect(frontmatter.recurrence_anchor).toBe("scheduled");
		expect(frontmatter.attachments).toEqual(["[[Attachments/receipt.jpg]]"]);
		expect(frontmatter.blockedBy).toEqual([{ uid: "[[Other Task]]", reltype: "FINISHTOSTART" }]);
		expect(frontmatter.tags).toEqual(expect.arrayContaining(["alpha", "task", "archived"]));
	});

	it("validates duplicate mapping values as invalid", () => {
		const duplicateMapping = {
			...DEFAULT_FIELD_MAPPING,
			status: "title",
		};

		const result = validateFieldMapping(duplicateMapping);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Field mappings must have unique property names");
	});
	it("reads and writes bundle only as true, also with settings saved before the field", () => {
		const { bundle: _omitted, ...oldMapping } = DEFAULT_FIELD_MAPPING;

		for (const mapping of [DEFAULT_FIELD_MAPPING, oldMapping]) {
			expect(mapTaskFromFrontmatter(mapping, { bundle: true }, "a.md").bundle).toBe(true);
			expect(mapTaskFromFrontmatter(mapping, { bundle: false }, "a.md")).not.toHaveProperty("bundle");
			expect(mapTaskFromFrontmatter(mapping, { bundle: "yes" }, "a.md")).not.toHaveProperty("bundle");
			expect(mapTaskToFrontmatter(mapping, { title: "A", bundle: true }).bundle).toBe(true);
			expect(mapTaskToFrontmatter(mapping, { title: "A" })).not.toHaveProperty("bundle");
		}
	});
});
