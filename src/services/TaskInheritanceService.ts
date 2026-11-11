import { TFile, type EventRef } from "obsidian";
import type TaskNotesPlugin from "../main";
import { inheritanceProperties } from "../core/fieldMapping";
import {
	copiedValues,
	findInheritedValues,
	reconcileInheritedValues,
	type InheritanceProperties,
	type SeenValues,
} from "../core/taskInheritance";
import { processVaultFrontMatter } from "./VaultMutationService";
import { resolveTaskParentPaths } from "./taskParentAssignment";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";

const tasknotesLogger = createTaskNotesLogger({ tag: "Services/TaskInheritanceService" });

type Frontmatter = Record<string, unknown>;

function frontmatterOf(plugin: TaskNotesPlugin, path: string): Frontmatter | undefined {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? plugin.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
}

function parentsOf(plugin: TaskNotesPlugin, frontmatter: Frontmatter | undefined, path: string): string[] {
	return resolveTaskParentPaths(
		frontmatter?.[plugin.fieldMapper.toUserField("projects")],
		path,
		(link, source) => plugin.app.metadataCache.getFirstLinkpathDest(link, source)?.path ?? null
	);
}

/**
 * Copies inherited values into a task about to be created. A priority equal to the default counts
 * as unset here, so the new task takes its parent's priority instead of the default.
 */
export function applyInheritedValuesToNewTask(
	plugin: TaskNotesPlugin,
	path: string,
	frontmatter: Frontmatter
): void {
	if (!plugin.settings.taskCreationDefaults.inheritParentTaskProperties) return;
	const props = inheritanceProperties(plugin.fieldMapper.getMapping());
	const inherited = findInheritedValues(
		path,
		props,
		(p) => (p === path ? frontmatter : frontmatterOf(plugin, p)),
		(p) => parentsOf(plugin, p === path ? frontmatter : frontmatterOf(plugin, p), p)
	);
	if (
		inherited.priority !== undefined &&
		frontmatter[props.priority] === plugin.settings.defaultTaskPriority
	) {
		delete frontmatter[props.priority];
	}
	reconcileInheritedValues(frontmatter, inherited, props);
}

/**
 * Keeps values copied from parents up to date. A changed task and its descendants are checked
 * shortly after each change. Existing tasks get copies only through `applyToAllTasks`.
 */
export class TaskInheritanceService {
	private refs: EventRef[] = [];
	private changed = new Set<string>();
	private timer: number | null = null;
	private queue: Promise<void> = Promise.resolve();
	// Copied values as last seen per task, to tell a hand edit from a stale copy.
	private seen = new Map<string, SeenValues>();

	constructor(private plugin: TaskNotesPlugin) {}

	initialize(): void {
		const props = this.props();
		for (const path of this.plugin.cacheManager.getAllTaskPaths()) {
			const frontmatter = frontmatterOf(this.plugin, path);
			if (frontmatter) this.seen.set(path, copiedValues(frontmatter, props));
		}
		this.refs.push(
			this.plugin.cacheManager.on("file-updated", (data: { path?: string }) => {
				if (data?.path) this.schedule(data.path);
			})
		);
	}

	destroy(): void {
		for (const ref of this.refs) this.plugin.cacheManager.offref(ref);
		this.refs = [];
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	/** Checks every task: copies values when the setting is on, removes all copies when it is off. */
	applyToAllTasks(): Promise<void> {
		return this.enqueue(() => this.check([...this.plugin.cacheManager.getAllTaskPaths()], false));
	}

	private props(): InheritanceProperties {
		return inheritanceProperties(this.plugin.fieldMapper.getMapping());
	}

	private schedule(path: string): void {
		if (!this.plugin.settings.taskCreationDefaults.inheritParentTaskProperties) return;
		this.changed.add(path);
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const changed = [...this.changed];
			this.changed.clear();
			void this.enqueue(() => this.check(changed, true));
		}, 500);
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(work).catch((error) => {
			tasknotesLogger.error("Could not update inherited task values:", {
				category: "internal",
				operation: "task-inheritance",
				error,
			});
		});
		return this.queue;
	}

	/** Checks `paths`, and with `withDescendants` everything below them, nearest first. */
	private async check(paths: string[], withDescendants: boolean): Promise<void> {
		const props = this.props();
		const enabled = this.plugin.settings.taskCreationDefaults.inheritParentTaskProperties;
		const tasks = [...this.plugin.cacheManager.getAllTaskPaths()];
		const frontmatters = new Map(tasks.map((path) => [path, frontmatterOf(this.plugin, path)]));
		const parents = new Map<string, string[]>();
		const children = new Map<string, string[]>();
		for (const [path, fm] of frontmatters) {
			const list = parentsOf(this.plugin, fm, path);
			parents.set(path, list);
			for (const parent of list) children.set(parent, [...(children.get(parent) ?? []), path]);
		}

		const targets: string[] = [];
		const visited = new Set<string>();
		const pending = [...paths];
		while (pending.length > 0) {
			const path = pending.shift() as string;
			if (visited.has(path)) continue;
			visited.add(path);
			targets.push(path);
			if (withDescendants) pending.push(...(children.get(path) ?? []));
		}

		const getFrontmatter = (path: string) => frontmatters.get(path);
		const getParents = (path: string) => parents.get(path) ?? [];
		for (const path of targets) {
			const inherited = enabled
				? findInheritedValues(path, props, getFrontmatter, getParents)
				: {};
			const updated = await this.reconcile(path, props, frontmatters.get(path), inherited);
			// Later descendants in this pass read the new values instead of the stale cache.
			if (updated) frontmatters.set(path, updated);
		}
	}

	private async reconcile(
		path: string,
		props: InheritanceProperties,
		current: Frontmatter | undefined,
		inherited: ReturnType<typeof findInheritedValues>
	): Promise<Frontmatter | null> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || !current) return null;
		const preview = structuredClone(current);
		if (!reconcileInheritedValues(preview, inherited, props, this.seen.get(path))) {
			this.seen.set(path, copiedValues(current, props));
			return null;
		}
		let written: Frontmatter | null = null;
		await processVaultFrontMatter(this.plugin.app, file, (frontmatter) => {
			if (!this.plugin.cacheManager.isTaskFile(frontmatter)) return;
			reconcileInheritedValues(frontmatter, inherited, props, this.seen.get(path));
			this.seen.set(path, copiedValues(frontmatter, props));
			written = structuredClone(frontmatter);
		});
		return written;
	}
}
