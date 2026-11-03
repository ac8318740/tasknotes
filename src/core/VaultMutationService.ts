import type { App, TFile } from "obsidian";

type FrontmatterMutationApp = {
	fileManager: {
		processFrontMatter(
			file: TFile,
			update: (frontmatter: Record<string, unknown>) => void
		): Promise<void>;
	};
};

type FileContentMutationApp = {
	vault: {
		process(file: TFile, update: (content: string) => string): Promise<string>;
	};
};

const vaultMutationQueues = new WeakMap<TFile, Promise<unknown>>();
let beforeVaultFileMutation: ((file: TFile) => Promise<void>) | null = null;

/** Run `hook` inside each file's mutation queue before TaskNotes changes the file. */
export function setBeforeVaultFileMutation(hook: ((file: TFile) => Promise<void>) | null): void {
	beforeVaultFileMutation = hook;
}

/**
 * Serialize TaskNotes mutations for one vault file while allowing unrelated
 * files to update concurrently. The queue complements Obsidian's atomic write
 * APIs when a workflow must fall back between different mutation APIs.
 */
export async function withVaultFileMutation<T>(
	file: TFile,
	mutation: () => Promise<T>
): Promise<T> {
	const previousMutation = vaultMutationQueues.get(file) ?? Promise.resolve();
	const hook = beforeVaultFileMutation;
	const run = hook
		? async () => {
				await hook(file);
				return mutation();
			}
		: mutation;
	const currentMutation = previousMutation.catch(() => undefined).then(run);
	vaultMutationQueues.set(file, currentMutation);

	try {
		return await currentMutation;
	} finally {
		if (vaultMutationQueues.get(file) === currentMutation) {
			vaultMutationQueues.delete(file);
		}
	}
}

export async function processVaultFrontMatter(
	app: FrontmatterMutationApp,
	file: TFile,
	update: (frontmatter: Record<string, unknown>) => void
): Promise<void> {
	await withVaultFileMutation(file, () =>
		processVaultFrontMatterWithinMutation(app, file, update)
	);
}

export async function processVaultFrontMatterWithinMutation(
	app: FrontmatterMutationApp,
	file: TFile,
	update: (frontmatter: Record<string, unknown>) => void
): Promise<void> {
	await app.fileManager.processFrontMatter(file, update);
}

export async function processVaultFile(
	app: FileContentMutationApp,
	file: TFile,
	update: (content: string) => string
): Promise<string> {
	return withVaultFileMutation(file, () => processVaultFileWithinMutation(app, file, update));
}

export async function processVaultFileWithinMutation(
	app: FileContentMutationApp,
	file: TFile,
	update: (content: string) => string
): Promise<string> {
	return app.vault.process(file, update);
}

export async function createVaultFile(app: App, path: string, content: string): Promise<TFile> {
	return app.vault.create(path, content);
}

export async function createVaultBinaryFile(
	app: App,
	path: string,
	data: ArrayBuffer
): Promise<TFile> {
	return app.vault.createBinary(path, data);
}

export async function createVaultFolder(app: App, path: string): Promise<void> {
	await app.vault.createFolder(path);
}

export async function modifyVaultFile(app: App, file: TFile, content: string): Promise<void> {
	await withVaultFileMutation(file, () => app.vault.modify(file, content));
}

export async function renameVaultFile(app: App, file: TFile, newPath: string): Promise<void> {
	await app.vault.rename(file, newPath);
}
