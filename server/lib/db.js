import mysql from "mysql2/promise";
import { loadEnv } from "./env.js";

const env = loadEnv() ?? process.env;

const {
    MYSQL_HOST = "localhost",
    MYSQL_PORT = "3306",
    MYSQL_USER = "root",
    MYSQL_PASSWORD = "",
    MYSQL_DATABASE = "ai_platform",
    MYSQL_POOL_SIZE = "10"
} = env;

const hasPassword = typeof MYSQL_PASSWORD === "string" && MYSQL_PASSWORD.length > 0;

const summary = {
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT) || 3306,
    user: MYSQL_USER,
    database: MYSQL_DATABASE,
    hasPassword
};

console.log(
    `[db] Initialising pool host=${summary.host} port=${summary.port} user=${summary.user} ` +
        `database=${summary.database} password=${summary.hasPassword ? "set" : "empty"}`
);

const pool = mysql.createPool({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(MYSQL_POOL_SIZE) || 10,
    namedPlaceholders: true
});

export default pool;

export function getPoolConfigSummary() {
    return { ...summary };
}
