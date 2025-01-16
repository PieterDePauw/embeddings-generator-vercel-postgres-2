import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

async function main() {
	// Seed data for the File model
	const file1 = await prisma.file.create({
		data: {
			content: "Sample content for file 1",
			filePath: "path/to/file1.md",
			fileHash: "hash1",
			latestVersion: "1.0",
			tokens: 100,
		},
	})

	const file2 = await prisma.file.create({
		data: {
			content: "Sample content for file 2",
			filePath: "path/to/file2.md",
			fileHash: "hash2",
			latestVersion: "1.0",
			tokens: 200,
		},
	})

	// Seed data for the Embedding model
	await prisma.embedding.createMany({
		data: [
			{
				filePath: file1.filePath,
				chunkIndex: 0,
				content: "Embedding content for file 1, chunk 0",
				embedding: [1, 2, 3],
			},
			{
				filePath: file1.filePath,
				chunkIndex: 1,
				content: "Embedding content for file 1, chunk 1",
				embedding: [4, 5, 6],
			},
			{
				filePath: file2.filePath,
				chunkIndex: 0,
				content: "Embedding content for file 2, chunk 0",
				embedding: [7, 8, 9],
			},
		],
	})

	console.log("Database has been seeded")
}

main()
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
	.finally(async () => {
		await prisma.$disconnect()
	})
