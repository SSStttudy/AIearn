import mysql,{type Pool,type ResultSetHeader,type RowDataPacket} from "mysql2/promise";
import {databaseConfig} from "./config.js";
let pool:Pool|undefined;
export function db():Pool{return pool??=mysql.createPool({...databaseConfig,connectionLimit:8,timezone:"Z"});}
export async function rows<T extends RowDataPacket[]>(sql:string,params:any[]=[]):Promise<T>{const [result]=await db().query<T>(sql,params);return result;}
export async function exec(sql:string,params:any[]=[]):Promise<ResultSetHeader>{const [result]=await db().execute<ResultSetHeader>(sql,params);return result;}
