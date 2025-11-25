import pool from "../lib/db.js";
import { ensureSchema } from "../lib/ensureSchema.js";

try {
    console.log("Starting database schema initialisation...");
    await ensureSchema({ logger: console });
    console.log("MySQL schema ensured successfully.");
} catch (error) {
    console.error("Failed to initialise database schema", error);
    process.exitCode = 1;
} finally {
    await pool.end().catch((err) => console.error("Failed to close MySQL pool", err));
}
