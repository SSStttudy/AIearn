import fs from "node:fs/promises";
import mysql from "mysql2/promise";
import {config,databaseConfig} from "./config.js";
const database=databaseConfig.database;if(!database)throw new Error("DATABASE_URL 必须包含数据库名");
const admin=await mysql.createConnection({...databaseConfig,database:undefined});await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database.replaceAll("`","``")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);await admin.end();
const connection=await mysql.createConnection({...databaseConfig,multipleStatements:true});await connection.query("CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
for(const file of (await fs.readdir(config.migrationsDir)).filter(f=>f.endsWith(".sql")).sort()){const [found]=await connection.query<mysql.RowDataPacket[]>("SELECT version FROM schema_migrations WHERE version = ?",[file]);if(found.length)continue;const sql=await fs.readFile(new URL(`file:///${config.migrationsDir.replaceAll("\\","/")}/${file}`),"utf8");await connection.beginTransaction();try{await connection.query(sql);await connection.execute("INSERT INTO schema_migrations(version) VALUES (?)",[file]);await connection.commit();}catch(error){await connection.rollback();throw error;}console.info(`Applied ${file}`);}await connection.end();
