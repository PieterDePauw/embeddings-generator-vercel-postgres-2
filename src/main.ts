/* eslint-disable object-shorthand */

// Information:
// We could use the following GitHub Action to get the commit hash that triggered the workflow: https://github.com/prompt/actions-commit-hash
// This could be useful for tracking the commit hash that triggered the workflow and storing it in the database for reference.

// Import modules
import * as core from "@actions/core"
import * as dotenv from "dotenv"
import crypto from "crypto"
import { PrismaClient } from "@prisma/client"
import { openai } from "@ai-sdk/openai"
import { embedMany } from "ai"
import { generateMarkdownSources } from "./markdown"
import { type MarkdownSourceType, type EmbeddingModel, type Section } from "./types"

// Define the constants
const OPENAI_USER_ID = "user-id"
const OPENAI_EMBEDDING_MODEL: EmbeddingModel = { name: "text-embedding-3-small", dimensions: 1536, pricing: 0.00002, maxRetries: 2 }
const EMBEDDING_MODEL = openai.embedding(OPENAI_EMBEDDING_MODEL.name, { dimensions: OPENAI_EMBEDDING_MODEL.dimensions, user: OPENAI_USER_ID })

// Initialize the environment variables from the .env file
dotenv.config({ path: [".env.local", ".env"], override: true })

// >> Initialize Prisma with the database URL
const prisma = new PrismaClient({ datasources: { db: { url: core.getInput("database-url") } } })

/**
 * @name generateVersionInfo
 * @description Generates a new refresh version and timestamp for the document.
 * @returns An object containing the refresh version and timestamp
 */
function generateVersionInfo(): { refreshVersion: string; refreshDate: Date } {
	// > Check if the GITHUB_SHA environment variable is set and not equal to "NO_SHA_FOUND"
	const hasGithubSha: boolean = process.env.GITHUB_SHA && process.env.GITHUB_SHA !== "NO_SHA_FOUND"
	// > Return the refresh version either as the GITHUB_SHA or a random UUID and the refresh date as the current timestamp
	return { refreshVersion: hasGithubSha ? process.env.GITHUB_SHA : crypto.randomUUID(), refreshDate: new Date() }
}

/**
 * @name compareChecksum
 * @description Compares the hash checksum of a file with the database and returns whether the file is found and whether it has changed.
 * @param filePath - The path to the file
 * @param hash - The hash checksum of the file
 * @returns An object indicating whether the file is found and whether it has changed
 */
async function compareChecksum(filePath: string, hash: string): Promise<{ isFileFound: boolean; isFileChanged: boolean | null }> {
	// > Check if a file with the same path already exists in the database
	const existingFile = await prisma.file.findFirst({ where: { filePath: filePath } })
	// > If the file does not exist, return that the file is not found
	if (!existingFile) return { isFileFound: false, isFileChanged: null }
	// > If the file exists and the hash is the same, return that the file has not changed
	if (existingFile && existingFile.fileHash === hash) return { isFileFound: true, isFileChanged: false }
	// > If the file exists and the hash is different, return that the file has changed
	if (existingFile && existingFile.fileHash !== hash) return { isFileFound: true, isFileChanged: true }
	// > If an unexpected error occurs, throw an error
	throw new Error("An unexpected error occurred while comparing the checksum.")
}

/**
 * @name embedSections
 * @description Embeds sections in a single request and returns the embeddings along with total token usage.
 * @param sections - An array of sections to embed
 * @returns An object containing the embeddings and total token usage
 */
export async function embedSections(sections: Section[]): Promise<{ embeddings: number[][]; tokens: number; sections: Section[] }> {
	// > Sort the sections based on the slug
	const sectionsData: Section[] = sections.sort((a, b) => a.slug.localeCompare(b.slug))
	// > Embed the sections using the OpenAI API
	const result = await embedMany({ values: sectionsData.map((section) => section.content), model: EMBEDDING_MODEL, maxRetries: OPENAI_EMBEDDING_MODEL.maxRetries })
	// > Return the embeddings, total token usage, and sections data
	return { embeddings: result.embeddings, tokens: result.usage.tokens, sections: sectionsData }
}

// Function to run the action
async function run(): Promise<void> {
	try {
		// > Get the input for the database URL
		const databaseUrl: string | undefined = core.getInput("database-url")
		if (!databaseUrl) throw new Error("The inputs 'database-url' must be provided.")

		// > Get the input for the OpenAI API key
		const openaiApiKey: string | undefined = core.getInput("openai-api-key")
		if (!openaiApiKey) throw new Error("The inputs 'openai-api-key' must be provided.")

		// > Get the input for the docs root path
		const docsRootPath: string = core.getInput("docs-root-path") || "docs"

		// > Get the input for whether to refresh all embeddings or only the ones that have changed
		const shouldRefresh: boolean = core.getInput("should-refresh") === "true" || false

		// > Get the latest commit hash that triggered the workflow and generate a new refresh version and timestamp for the document
		const { refreshVersion, refreshDate } = generateVersionInfo()

		// > Gather all .md / .mdx files in the content directory and subdirectories
		const markdownFiles: MarkdownSourceType[] = await generateMarkdownSources({ docsRootPath: docsRootPath, ignoredFiles: ["pages/404.mdx"] })

		// A. Check if we should refresh all embeddings or only the ones that have changed
		if (!shouldRefresh) {
			// A. Process each file
			for (const markdownFile of markdownFiles) {
				// > Compute a hash checksum based on the raw content of the file using the SHA-256 algorithm and compare with the database
				const { isFileFound, isFileChanged } = await compareChecksum(markdownFile.path, markdownFile.checksum)

				// > If the file is found but it has not changed, update the file in the database and skip processing
				if (isFileFound && !isFileChanged) {
					// >> Update the last refresh timestamp for the file in the database
					await prisma.file.update({ where: { filePath: markdownFile.path }, data: { latestRefresh: refreshDate, latestVersion: refreshVersion } })
					// >> Skip to the next file
					continue
				}

				// > If the file was not found in the database or if the file was found and has changed, generate new embeddings for the file
				if (!isFileFound || (isFileFound && isFileChanged)) {
					// >> If the file was not found in the database, insert the file into the database
					if (!isFileFound) {
						const newFileData = { content: markdownFile.content, filePath: markdownFile.path, fileHash: markdownFile.checksum, tokens: 0, latestRefresh: refreshDate, latestVersion: refreshVersion }
						await prisma.file.create({ data: newFileData })
					}

					// >> If the file has changed, delete existing embeddings for the file
					if (isFileChanged) {
						await prisma.embedding.deleteMany({ where: { filePath: markdownFile.path } })
					}

					// >> Generate embeddings for each section
					const { embeddings, tokens, sections } = await embedSections(markdownFile.sections)

					// >> If the file has changed, update the file in the database
					const updatedFileData = { content: markdownFile.content, filePath: markdownFile.path, fileHash: markdownFile.checksum, latestRefresh: refreshDate, latestVersion: refreshVersion, tokens: tokens }
					await prisma.file.update({ where: { filePath: markdownFile.path }, data: updatedFileData })

					// >> Insert the embeddings into the database
					const newEmbeddingData = embeddings.map((embedding, index) => ({ filePath: markdownFile.path, chunkIndex: index, header: sections[index].heading, slug: sections[index].slug, content: sections[index].content, embedding: embedding }))
					await prisma.embedding.createMany({ data: newEmbeddingData })
				}
			}

			// B. Delete all existing files from the database that were not found in the content directory
			const existingFiles = await prisma.file.findMany()
			const existingFilePaths = existingFiles.map((file) => file.filePath)
			const missingFiles = existingFilePaths.filter((filePath) => !markdownFiles.some((markdownFile) => markdownFile.path === filePath))
			await prisma.file.deleteMany({ where: { filePath: { in: missingFiles } } })

			// C. Delete all existing embeddings from the database that do not have a corresponding file
			const existingEmbeddings = await prisma.embedding.findMany()
			const existingEmbeddingPaths = existingEmbeddings.map((embedding) => embedding.filePath)
			const missingEmbeddings = existingEmbeddingPaths.filter((filePath) => !markdownFiles.some((markdownFile) => markdownFile.path === filePath))
			await prisma.embedding.deleteMany({ where: { filePath: { in: missingEmbeddings } } })
		}

		// B. Refresh all embeddings for all files
		if (shouldRefresh) {
			// A. Delete all existing files from the database
			await prisma.file.deleteMany({})
			// B. Delete all existing embeddings from the database
			await prisma.embedding.deleteMany({})
			// C. Process each file
			for (const markdownFile of markdownFiles) {
				// >> Generate embeddings for each section
				const { embeddings, sections, tokens } = await embedSections(markdownFile.sections)

				// >> Insert the file into the database
				const fileData = { content: markdownFile.content, filePath: markdownFile.path, fileHash: markdownFile.checksum, tokens: tokens, latestRefresh: refreshDate, latestVersion: refreshVersion }
				await prisma.file.create({ data: fileData })

				// >> Insert the embeddings into the database
				const embeddingData = embeddings.map((embedding, index) => ({ filePath: markdownFile.path, chunkIndex: index, header: sections[index].heading, slug: sections[index].slug, content: sections[index].content, embedding: embedding }))
				await prisma.embedding.createMany({ data: embeddingData })
			}
		}
	} catch (error) {
		// >> Log the error
		core.setFailed(error.message)
	} finally {
		await prisma.$disconnect() // ensures the process can exit cleanly
	}
}

// Run the action
run()
