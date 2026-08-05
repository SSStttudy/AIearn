import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
const here=path.dirname(fileURLToPath(import.meta.url));
export const rootDir=path.resolve(here,"../../..");
dotenv.config({path:path.join(rootDir,".env")});
const webOrigins=(process.env.WEB_ORIGINS??process.env.WEB_ORIGIN??"http://localhost:5173,http://127.0.0.1:5173").split(",").map(value=>value.trim()).filter(Boolean);
export const config={port:Number(process.env.PORT??8787),webOrigins,databaseUrl:process.env.DATABASE_URL??"mysql://root:password@127.0.0.1:3306/ailearn",dataDir:path.join(rootDir,"data"),promptsDir:path.join(rootDir,"prompts"),migrationsDir:path.join(rootDir,"database","migrations"),cookieSecure:process.env.COOKIE_SECURE==="true",testApiKey:process.env.AILEARN_TEST_API_KEY??""};
const databaseUrl=new URL(config.databaseUrl);
const decode=(value:string)=>{try{return decodeURIComponent(value);}catch{return value;}};
export const databaseConfig={
  host:databaseUrl.hostname,
  port:Number(databaseUrl.port||3306),
  user:decode(databaseUrl.username),
  password:decode(databaseUrl.password),
  database:databaseUrl.pathname.slice(1)
};
