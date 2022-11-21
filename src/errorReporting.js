import path from "path";
import { accessSync } from "fs";
import findUp from 'find-up';
import Sentry from '@sentry/electron';
import dotenv from 'dotenv';
import { version } from '../package.json';

const envPath = findUp.sync(".env") ?? path.join(__dirname, "../.env");
try {
	accessSync(envPath);
	dotenv.config({ path: envPath });
} catch (error) {
	console.error(error);
}

if (process.env.SENTRY_DSN) {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		release: version,
	});
}
