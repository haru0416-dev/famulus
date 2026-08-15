import { createBackup } from "../../src/db/maintenance.ts"

const [source, backups] = process.argv.slice(2)
if (!source || !backups) throw new Error("source and backup directory are required")
createBackup(source, backups, { keep: 1 })
